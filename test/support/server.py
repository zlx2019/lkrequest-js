# /// script
# requires-python = ">=3.12"
# dependencies = ["httpbin", "asgiref", "hypercorn", "aioquic", "cryptography"]
# ///
"""Local HTTPS test server for the lkrequest-js test suite.

Ported from lkrequest-py `tests/conftest.py`: the httpbin app under hypercorn, served
over TLS with a self-signed certificate, speaking HTTP/1.1 and HTTP/2 on 127.0.0.1. A few
routes httpbin lacks are layered on top (`/early-hints`, `/upload-echo`, `/charset`,
`/flaky`, `/ws-echo`).

More servers run alongside, as in lkrequest-py: the same app with HTTP/3 enabled on a port
of its own (also on `::1` where the host has it), a MASQUE proxy (`masque_proxy.py`) whose
record the tests read through `/_test/masque/stats` and clear with `/_test/masque/reset` on
the main server, and an HTTP/3 server that fails every request (`h3_closing_server.py`), read
and cleared the same way through `/_test/h3-closing/*`.

Run with `uv run test/support/server.py`. Once listening, the server writes one JSON line
to stdout, `{"url", "ca", "key", "h3Url", "h3UrlIpv6", "masqueUrl", "h3ClosingUrl"}`, and
serves until its stdin is closed, so it never outlives the test runner that started it. `key`
is the certificate's private key, for servers a test file starts itself.
"""

from __future__ import annotations

import asyncio
import codecs
import datetime
import hashlib
import ipaddress
import json
import logging
import socket
import sys
import tempfile
import threading
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs

logger = logging.getLogger("lkrequest-js.test-server")

Scope = dict[str, Any]
Receive = Callable[[], Awaitable[dict[str, Any]]]
Send = Callable[[dict[str, Any]], Awaitable[None]]
AsgiApp = Callable[[Scope, Receive, Send], Awaitable[None]]

#: Default body for `/charset`. Encodable in GBK, Big5 and the other CJK charsets the
#: tests reach for, and every character is outside ASCII, so a decode that silently fell
#: back to UTF-8 cannot accidentally pass.
CHARSET_SAMPLE = "中文测试"

#: Text frame that makes `/ws-echo` describe the handshake it received instead of echoing.
WS_HANDSHAKE_PROBE = "__handshake__"


def make_self_signed_cert(cert_path: Path, key_path: Path) -> bytes:
    """Write a self-signed cert/key; return the PEM.

    It is valid for localhost, 127.0.0.1, ::1 and every name under ``lkrequest.test``, which the
    DNS tests point at this server with a resolver of their own.
    """
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    san = x509.SubjectAlternativeName(
        [
            x509.DNSName("localhost"),
            x509.DNSName("*.lkrequest.test"),
            x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
            x509.IPAddress(ipaddress.ip_address("::1")),
        ]
    )
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=3650))
        .add_extension(san, critical=False)
        .sign(key, hashes.SHA256())
    )
    cert_pem = cert.public_bytes(serialization.Encoding.PEM)
    key_pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption(),
    )
    cert_path.write_bytes(cert_pem)
    key_path.write_bytes(key_pem)
    return cert_pem


def free_port() -> int:
    """Ask the OS for an unused TCP port on 127.0.0.1."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def ipv6_loopback_available() -> bool:
    """Whether this host can bind the IPv6 loopback `::1`."""
    try:
        with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as sock:
            sock.bind(("::1", 0))
        return True
    except OSError:
        return False


def with_early_hints(inner: AsgiApp) -> AsgiApp:
    """Add an `/early-hints` route that emits `103` before its final `200`.

    httpbin is a WSGI app and cannot send 1xx responses. Hypercorn only offers the
    extension on HTTP/2 and HTTP/3, so on HTTP/1.1 the client just sees the final response.
    """

    async def app(scope: Scope, receive: Receive, send: Send) -> None:
        """Serve `/early-hints`, delegate everything else."""
        if scope["type"] != "http" or scope["path"] != "/early-hints":
            await inner(scope, receive, send)
            return
        if "http.response.early_hint" in scope.get("extensions", {}):
            await send(
                {"type": "http.response.early_hint", "links": [b"</style.css>; rel=preload; as=style"]}
            )
        await send(
            {"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/plain")]}
        )
        await send({"type": "http.response.body", "body": b"final"})

    return app


def with_upload_echo(inner: AsgiApp) -> AsgiApp:
    """Add an `/upload-echo` route that reports the request body it read.

    WSGI cannot read a body without `Content-Length`, so streaming uploads need a handler
    that reads the ASGI body itself. It reports the byte count, the digest, the framing
    headers (how a test tells `Content-Length` from chunked framing) and the method exactly
    as sent, since httpbin's own routes refuse non-standard methods.
    """

    async def app(scope: Scope, receive: Receive, send: Send) -> None:
        """Serve `/upload-echo`, delegate everything else."""
        if scope["type"] != "http" or scope["path"] != "/upload-echo":
            await inner(scope, receive, send)
            return
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] != "http.request":
                break
            body.extend(message.get("body", b""))
            if not message.get("more_body", False):
                break
        headers = {key.decode("latin-1"): value.decode("latin-1") for key, value in scope["headers"]}
        payload = json.dumps(
            {
                "length": len(body),
                "sha256": hashlib.sha256(body).hexdigest(),
                "content_type": headers.get("content-type"),
                "content_length": headers.get("content-length"),
                "transfer_encoding": headers.get("transfer-encoding"),
                "http_version": scope.get("http_version"),
                "method": scope.get("method"),
            }
        ).encode()
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(payload)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": payload})

    return app


def with_charset_body(inner: AsgiApp) -> AsgiApp:
    """Add a `/charset` route serving a body in a non-UTF-8 charset.

    Query parameters: `label` (encoding of the body, default `gbk`), `text` (content,
    default `CHARSET_SAMPLE`), `declare` (the `charset=` sent back, default `label`; `0`
    omits it) and `bom=1` (prefix a UTF-8 BOM).
    """

    async def app(scope: Scope, receive: Receive, send: Send) -> None:
        """Serve `/charset`, delegate everything else."""
        if scope["type"] != "http" or scope["path"] != "/charset":
            await inner(scope, receive, send)
            return
        query = parse_qs(scope.get("query_string", b"").decode("latin-1"))
        label = query.get("label", ["gbk"])[0]
        body = query.get("text", [CHARSET_SAMPLE])[0].encode(label)
        if query.get("bom", ["0"])[0] == "1":
            body = codecs.BOM_UTF8 + body
        declared = query.get("declare", [label])[0]
        content_type = "text/plain" if declared == "0" else f"text/plain; charset={declared}"
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [
                    (b"content-type", content_type.encode("latin-1")),
                    (b"content-length", str(len(body)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})

    return app


def with_flaky(inner: AsgiApp) -> AsgiApp:
    """Add a `/flaky` route that fails a set number of times before it succeeds.

    `/flaky?key=K&fail=N&status=S` answers status `S` (default 503) to the first `N` requests
    for key `K`, then `200`; every answer is JSON `{"attempt": n}`, counting from 1. Tests
    use a unique key each, which is how they count the attempts a retry policy made.
    """
    attempts: dict[str, int] = {}

    async def app(scope: Scope, receive: Receive, send: Send) -> None:
        """Serve `/flaky`, delegate everything else."""
        if scope["type"] != "http" or scope["path"] != "/flaky":
            await inner(scope, receive, send)
            return
        query = parse_qs(scope.get("query_string", b"").decode("latin-1"))
        key = query.get("key", [""])[0]
        fail = int(query.get("fail", ["0"])[0])
        status = int(query.get("status", ["503"])[0])
        attempts[key] = attempts.get(key, 0) + 1
        attempt = attempts[key]
        body = json.dumps({"attempt": attempt}).encode()
        await send(
            {
                "type": "http.response.start",
                "status": status if attempt <= fail else 200,
                "headers": [(b"content-type", b"application/json")],
            }
        )
        await send({"type": "http.response.body", "body": body})

    return app


def with_websocket_echo(inner: AsgiApp) -> AsgiApp:
    """Add a `/ws-echo` WebSocket endpoint that echoes every frame it receives.

    httpbin has no WebSocket route. Hypercorn computes `Sec-WebSocket-Accept` per RFC 6455,
    so completing a handshake against it pins the client's side of the handshake.

    Sending `WS_HANDSHAKE_PROBE` returns JSON with the request target and `Host` header the
    server saw, which is how the tests check the upgrade request itself.
    """

    async def app(scope: Scope, receive: Receive, send: Send) -> None:
        """Serve `/ws-echo`, delegate everything that is not a WebSocket."""
        if scope["type"] != "websocket":
            await inner(scope, receive, send)
            return
        message = await receive()
        if message["type"] != "websocket.connect":
            return
        if scope.get("path") != "/ws-echo":
            await send({"type": "websocket.close", "code": 1000})
            return
        await send({"type": "websocket.accept"})
        while True:
            message = await receive()
            if message["type"] == "websocket.disconnect":
                return
            if message["type"] != "websocket.receive":
                continue
            text = message.get("text")
            if text == WS_HANDSHAKE_PROBE:
                host = next((v for k, v in scope.get("headers", []) if k == b"host"), b"")
                seen = {
                    "raw_path": scope.get("raw_path", b"").decode("latin-1"),
                    "host": host.decode("latin-1"),
                }
                await send({"type": "websocket.send", "text": json.dumps(seen)})
            elif text is not None:
                await send({"type": "websocket.send", "text": text})
            elif message.get("bytes") is not None:
                await send({"type": "websocket.send", "bytes": message["bytes"]})

    return app


def with_masque_control(inner: AsgiApp, proxy: Any) -> AsgiApp:
    """Add `/_test/masque/stats` (GET) and `/_test/masque/reset` (POST) for the MASQUE proxy.

    The reset body may be `{"required_header": [name, value]}`: the proxy then answers `407`
    to any CONNECT without that header.
    """

    async def app(scope: Scope, receive: Receive, send: Send) -> None:
        """Serve the control routes, delegate everything else."""
        path = scope.get("path", "")
        if scope["type"] != "http" or not path.startswith("/_test/masque/"):
            await inner(scope, receive, send)
            return
        if path == "/_test/masque/reset":
            body = bytearray()
            while True:
                message = await receive()
                body.extend(message.get("body", b""))
                if not message.get("more_body", False):
                    break
            required = json.loads(body or b"{}").get("required_header")
            proxy.reset(tuple(required) if required else None)
            payload = b"{}"
        else:
            payload = json.dumps(proxy.stats.to_json()).encode()
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"content-type", b"application/json")],
            }
        )
        await send({"type": "http.response.body", "body": payload})

    return app


def with_h3_closing_control(inner: AsgiApp, closing: Any) -> AsgiApp:
    """Add `/_test/h3-closing/stats` (GET) and `/_test/h3-closing/reset` (POST) for the
    HTTP/3 server that fails every request: the stats report the connections it accepted."""

    async def app(scope: Scope, receive: Receive, send: Send) -> None:
        """Serve the control routes, delegate everything else."""
        path = scope.get("path", "")
        if scope["type"] != "http" or not path.startswith("/_test/h3-closing/"):
            await inner(scope, receive, send)
            return
        if path == "/_test/h3-closing/reset":
            closing.reset()
            payload = b"{}"
        else:
            payload = json.dumps({"connections": closing.connections}).encode()
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"content-type", b"application/json")],
            }
        )
        await send({"type": "http.response.body", "body": payload})

    return app


def concurrent_wsgi(wsgi_app: Any) -> AsgiApp:
    """Wrap a WSGI app as ASGI, running requests concurrently on a thread pool.

    asgiref's `WsgiToAsgi` runs every request through `sync_to_async` with its default
    `thread_sensitive=True`, i.e. one shared thread: a single `/delay/5` would stall every
    other request. lkrequest-py runs its tests one at a time and never notices; the test
    files here run in parallel, so each request gets a pool thread instead.
    """
    from asgiref.sync import sync_to_async
    from asgiref.wsgi import WsgiToAsgiInstance

    class ConcurrentInstance(WsgiToAsgiInstance):
        """`WsgiToAsgiInstance` whose WSGI call is not pinned to the shared thread."""

        # Read through `__dict__`: plain attribute access would bind the descriptor and hand
        # back an async wrapper instead of the original sync function.
        run_wsgi_app = sync_to_async(
            WsgiToAsgiInstance.__dict__["run_wsgi_app"].func, thread_sensitive=False
        )

    async def app(scope: Scope, receive: Receive, send: Send) -> None:
        """Serve one request through a fresh instance, like `WsgiToAsgi` does."""
        await ConcurrentInstance(wsgi_app)(scope, receive, send)

    return app


def build_app() -> AsgiApp:
    """httpbin wrapped as ASGI, with the extra routes layered on top."""
    from httpbin import app as flask_app

    app = with_charset_body(with_upload_echo(with_early_hints(concurrent_wsgi(flask_app))))
    return with_websocket_echo(with_flaky(app))


def server_config(port: int, cert_file: Path, key_file: Path, *, http3: bool) -> Any:
    """Hypercorn settings for one server on `port`."""
    from hypercorn.config import Config

    config = Config()
    config.bind = [f"127.0.0.1:{port}"]
    config.certfile = str(cert_file)
    config.keyfile = str(key_file)
    config.loglevel = "ERROR"
    if http3:
        # HTTP/3 on the same port over UDP, also on ::1 so IPv6 targets can be tested.
        if ipv6_loopback_available():
            config.bind.append(f"[::1]:{port}")
        config.quic_bind = list(config.bind)
        config.alpn_protocols = ["h3", "h2", "http/1.1"]
    else:
        # No quic_bind: without Alt-Svc h3 the Chrome protocol policy never upgrades to
        # HTTP/3, which keeps protocol selection deterministic for behavioural tests.
        config.alpn_protocols = ["h2", "http/1.1"]
    return config


async def wait_until_listening(port: int, timeout: float = 15.0) -> None:
    """Poll the port until the server accepts connections."""
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        try:
            _, writer = await asyncio.open_connection("127.0.0.1", port)
            writer.close()
            return
        except OSError:
            if asyncio.get_running_loop().time() > deadline:
                raise RuntimeError(f"test server on port {port} did not start in time") from None
            await asyncio.sleep(0.05)


def watch_stdin(loop: asyncio.AbstractEventLoop, stop: asyncio.Event) -> None:
    """Block on stdin in a daemon thread and set `stop` once the parent closes it."""

    def run() -> None:
        """Read until EOF, then signal the event loop."""
        sys.stdin.buffer.read()
        loop.call_soon_threadsafe(stop.set)

    threading.Thread(target=run, name="stdin-watch", daemon=True).start()


async def serve() -> None:
    """Start the servers, announce them on stdout, and run until stdin closes."""
    from hypercorn.asyncio import serve as hypercorn_serve

    from h3_closing_server import H3ClosingServer
    from masque_proxy import MasqueProxy

    certs = Path(tempfile.mkdtemp(prefix="lkrequest-js-certs-"))
    cert_file, key_file = certs / "cert.pem", certs / "key.pem"
    ca_pem = make_self_signed_cert(cert_file, key_file)

    proxy = MasqueProxy()
    await proxy.start(str(cert_file), str(key_file))
    closing = H3ClosingServer()
    await closing.start(str(cert_file), str(key_file))
    app = with_h3_closing_control(with_masque_control(build_app(), proxy), closing)

    port, h3_port = free_port(), free_port()
    config = server_config(port, cert_file, key_file, http3=False)
    h3_config = server_config(h3_port, cert_file, key_file, http3=True)

    stop = asyncio.Event()
    watch_stdin(asyncio.get_running_loop(), stop)
    servers = [
        asyncio.create_task(hypercorn_serve(app, config, shutdown_trigger=stop.wait)),
        asyncio.create_task(hypercorn_serve(app, h3_config, shutdown_trigger=stop.wait)),
    ]
    await wait_until_listening(port)
    await wait_until_listening(h3_port)
    announcement = {
        "url": f"https://127.0.0.1:{port}",
        "ca": ca_pem.decode(),
        "key": key_file.read_text(),
        "h3Url": f"https://127.0.0.1:{h3_port}",
        "h3UrlIpv6": f"https://[::1]:{h3_port}" if len(h3_config.bind) > 1 else None,
        "masqueUrl": proxy.url,
        "h3ClosingUrl": closing.url,
    }
    sys.stdout.write(json.dumps(announcement) + "\n")
    sys.stdout.flush()
    logger.info("test servers listening on ports %d and %d", port, h3_port)
    # Shutting down cancels handlers parked on a QUIC stream the client already reset, and
    # hypercorn may then raise from serve(); once stdin closed that is teardown noise.
    results = await asyncio.gather(*servers, return_exceptions=True)
    for result in results:
        if isinstance(result, BaseException) and not stop.is_set():
            raise result


def main() -> None:
    """Entry point."""
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
    asyncio.run(serve())


if __name__ == "__main__":
    main()
