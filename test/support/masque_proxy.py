"""A minimal MASQUE CONNECT-UDP proxy (RFC 9298) for the local tests.

Ported from lkrequest-py `tests/_masque_proxy.py`. It speaks just enough of the protocol to
carry a real tunnel: an HTTP/3 server that accepts extended CONNECT with
`:protocol connect-udp`, answers `200` with `capsule-protocol: ?1`, and relays HTTP Datagrams
(context ID 0) to and from a UDP socket connected to the target named in the path. Every
CONNECT is recorded, so a test can tell a request that went through the tunnel from one that
did not.

Unlike the Python original it runs on the test server's own event loop, and the tests read
what it saw through the server's `/_test/masque/*` routes, since they live in another process.

It is a test double, not a proxy: no capsule parsing, no URI template beyond the default
`/.well-known/masque/udp/{host}/{port}/`, and no limits.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import unquote

from aioquic.asyncio import QuicConnectionProtocol, serve
from aioquic.buffer import Buffer, BufferReadError
from aioquic.h3.connection import H3_ALPN, H3Connection
from aioquic.h3.events import DatagramReceived, HeadersReceived
from aioquic.quic.configuration import QuicConfiguration
from aioquic.quic.events import ConnectionTerminated

PATH_PREFIX = "/.well-known/masque/udp/"


@dataclass
class ConnectRecord:
    """One CONNECT-UDP request as the proxy saw it."""

    target: tuple[str, int] | None
    headers: dict[str, str]
    status: int


@dataclass
class MasqueProxyStats:
    """What the proxy has seen since the last reset."""

    connects: list[ConnectRecord] = field(default_factory=list)
    datagrams_to_target: int = 0
    datagrams_to_client: int = 0

    def to_json(self) -> dict[str, Any]:
        """The stats as JSON for the control route."""
        return {
            "connects": [
                {
                    "target": list(record.target) if record.target else None,
                    "headers": record.headers,
                    "status": record.status,
                }
                for record in self.connects
            ],
            "datagrams_to_target": self.datagrams_to_target,
            "datagrams_to_client": self.datagrams_to_client,
        }


@dataclass
class ProxyState:
    """State shared by every connection to the proxy."""

    stats: MasqueProxyStats
    required_header: tuple[str, str] | None = None


class TargetSocket(asyncio.DatagramProtocol):
    """The proxy's UDP socket towards one tunnel's target."""

    def __init__(self, proxy: ProxyProtocol, stream_id: int) -> None:
        self._proxy = proxy
        self._stream_id = stream_id

    def datagram_received(self, data: bytes, addr: tuple[str, int]) -> None:
        """Relays a datagram from the target back into the tunnel."""
        self._proxy.forward_to_client(self._stream_id, data)


class ProxyProtocol(QuicConnectionProtocol):
    """One client connection to the proxy, carrying any number of tunnels."""

    def __init__(self, *args: Any, state: ProxyState, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        # `enable_webtransport` is what makes aioquic advertise H3_DATAGRAM.
        self._h3 = H3Connection(self._quic, enable_webtransport=True)
        self._state = state
        self._tunnels: dict[int, asyncio.DatagramTransport] = {}

    def quic_event_received(self, event: Any) -> None:
        """Dispatches QUIC and HTTP/3 events."""
        if isinstance(event, ConnectionTerminated):
            for transport in self._tunnels.values():
                transport.close()
            self._tunnels.clear()
        for h3_event in self._h3.handle_event(event):
            if isinstance(h3_event, HeadersReceived):
                self._on_headers(h3_event)
            elif isinstance(h3_event, DatagramReceived):
                self._on_datagram(h3_event)

    def _on_headers(self, event: HeadersReceived) -> None:
        """Answers a CONNECT-UDP request, opening the tunnel when it is acceptable."""
        headers = {key.decode(): value.decode() for key, value in event.headers}
        target = parse_target(headers)
        status = self._decide(headers, target)
        self._state.stats.connects.append(ConnectRecord(target, headers, status))
        if status != 200 or target is None:
            self._respond(event.stream_id, status, end_stream=True)
            return
        asyncio.ensure_future(self._open_tunnel(event.stream_id, target))

    def _decide(self, headers: dict[str, str], target: tuple[str, int] | None) -> int:
        """The status to answer a CONNECT request with."""
        if headers.get(":method") != "CONNECT" or headers.get(":protocol") != "connect-udp":
            return 400
        if target is None:
            return 400
        required = self._state.required_header
        if required is not None and headers.get(required[0]) != required[1]:
            return 407
        return 200

    async def _open_tunnel(self, stream_id: int, target: tuple[str, int]) -> None:
        """Connects the target socket, then accepts the tunnel."""
        loop = asyncio.get_running_loop()
        transport, _ = await loop.create_datagram_endpoint(
            lambda: TargetSocket(self, stream_id), remote_addr=target
        )
        self._tunnels[stream_id] = transport
        # The socket exists before the 2xx, so the first datagram the client sends after it
        # has somewhere to go.
        self._respond(stream_id, 200, end_stream=False)

    def _respond(self, stream_id: int, status: int, *, end_stream: bool) -> None:
        """Sends the response headers of a CONNECT request."""
        headers = [(b":status", str(status).encode())]
        if status == 200:
            headers.append((b"capsule-protocol", b"?1"))
        self._h3.send_headers(stream_id, headers, end_stream=end_stream)
        self.transmit()

    def _on_datagram(self, event: DatagramReceived) -> None:
        """Relays a tunnel datagram (context ID 0) to the target."""
        buf = Buffer(data=event.data)
        try:
            context_id = buf.pull_uint_var()
        except BufferReadError:
            return
        transport = self._tunnels.get(event.stream_id)
        # Context ID 0 is the UDP payload (RFC 9298 §4); anything else is an extension this
        # double does not speak, and is dropped as the RFC says.
        if context_id != 0 or transport is None:
            return
        self._state.stats.datagrams_to_target += 1
        transport.sendto(event.data[buf.tell() :])

    def forward_to_client(self, stream_id: int, payload: bytes) -> None:
        """Sends a target datagram to the client inside its tunnel."""
        self._state.stats.datagrams_to_client += 1
        self._h3.send_datagram(stream_id, b"\x00" + payload)
        self.transmit()


def parse_target(headers: dict[str, str]) -> tuple[str, int] | None:
    """The `(host, port)` a CONNECT-UDP path names, or `None` when it names none."""
    path = headers.get(":path", "")
    if not path.startswith(PATH_PREFIX):
        return None
    parts = path[len(PATH_PREFIX) :].strip("/").split("/")
    if len(parts) != 2 or not parts[1].isdigit():
        return None
    return unquote(parts[0]), int(parts[1])


class MasqueProxy:
    """A proxy on `127.0.0.1:<port>` (UDP), running on the caller's event loop."""

    def __init__(self) -> None:
        self.stats = MasqueProxyStats()
        self._state = ProxyState(self.stats)
        self.port = 0

    async def start(self, cert_file: str, key_file: str) -> None:
        """Starts listening on a free UDP port."""
        config = QuicConfiguration(
            is_client=False,
            alpn_protocols=H3_ALPN,
            # Room for a full-size inner QUIC packet plus the DATAGRAM framing.
            max_datagram_frame_size=65536,
            max_datagram_size=1452,
        )
        config.load_cert_chain(cert_file, key_file)
        server = await serve(
            "127.0.0.1",
            0,
            configuration=config,
            create_protocol=lambda *args, **kwargs: ProxyProtocol(
                *args, state=self._state, **kwargs
            ),
        )
        self.port = server._transport.get_extra_info("sockname")[1]

    @property
    def url(self) -> str:
        """The proxy URL to configure a client with."""
        return f"masque://127.0.0.1:{self.port}"

    def reset(self, required_header: tuple[str, str] | None = None) -> None:
        """Forgets what was seen, and optionally demands one request header."""
        self.stats.connects.clear()
        self.stats.datagrams_to_target = 0
        self.stats.datagrams_to_client = 0
        self._state.required_header = required_header
