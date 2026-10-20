"""An HTTP/3 server that fails every request with a protocol error, for the `h3RetryMode` tests.

Ported from lkrequest-py `tests/test_h3_retry.py`. It accepts a QUIC connection, reads the
first request on it and closes the connection with H3_INTERNAL_ERROR, so every attempt fails
the same way and the connections it accepted are the attempts a client made. It runs on the
test server's own event loop, and the tests read the count through the server's
`/_test/h3-closing/*` routes.
"""

from __future__ import annotations

from typing import Any

from aioquic.asyncio import QuicConnectionProtocol, serve
from aioquic.h3.connection import H3_ALPN, H3Connection
from aioquic.h3.events import HeadersReceived
from aioquic.quic.configuration import QuicConfiguration
from aioquic.quic.events import ProtocolNegotiated

#: The HTTP/3 error code every connection is closed with (RFC 9114 §8.1).
H3_INTERNAL_ERROR = 0x102


class H3ClosingServer:
    """The server on `127.0.0.1:<port>` (UDP), running on the caller's event loop."""

    def __init__(self) -> None:
        self.connections = 0
        self.port = 0

    async def start(self, cert_file: str, key_file: str) -> None:
        """Starts listening on a free UDP port."""
        server = self

        class Protocol(QuicConnectionProtocol):
            """One client connection, closed at its first request."""

            def __init__(self, *args: Any, **kwargs: Any) -> None:
                super().__init__(*args, **kwargs)
                self._h3: H3Connection | None = None
                server.connections += 1

            def quic_event_received(self, event: Any) -> None:
                """Closes the connection once the headers of a request arrive."""
                if isinstance(event, ProtocolNegotiated):
                    self._h3 = H3Connection(self._quic)
                if self._h3 is None:
                    return
                for h3_event in self._h3.handle_event(event):
                    if isinstance(h3_event, HeadersReceived):
                        self._quic.close(error_code=H3_INTERNAL_ERROR, reason_phrase="closing")
                        self.transmit()

        config = QuicConfiguration(is_client=False, alpn_protocols=H3_ALPN)
        config.load_cert_chain(cert_file, key_file)
        listener = await serve("127.0.0.1", 0, configuration=config, create_protocol=Protocol)
        self.port = listener._transport.get_extra_info("sockname")[1]

    @property
    def url(self) -> str:
        """The base URL to send requests to."""
        return f"https://127.0.0.1:{self.port}"

    def reset(self) -> None:
        """Forgets the connections seen so far."""
        self.connections = 0
