"""Bounded viewer readiness probe: a WebSocket upgrade and an actual RFB banner.

This opens a view-only connection and sends no RFB authentication or input events.
Socket files alone can survive a failed transport and are not readiness evidence.
"""
import base64
import hashlib
import os
import socket
import time


def probe_viewer(path, timeout=1.5):
    deadline = time.monotonic() + timeout
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    expected = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest())
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as stream:
            stream.settimeout(timeout)
            stream.connect(path)
            stream.sendall(("GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: binary\r\nSec-WebSocket-Key: " + key + "\r\n\r\n").encode("ascii"))
            pending = bytearray()

            def receive():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError()
                stream.settimeout(remaining)
                chunk = stream.recv(4096)
                if not chunk:
                    raise EOFError()
                pending.extend(chunk)

            def take(size):
                while len(pending) < size:
                    receive()
                value = bytes(pending[:size])
                del pending[:size]
                return value

            while b"\r\n\r\n" not in pending:
                if len(pending) > 8192:
                    return False
                receive()
            header_end = pending.index(b"\r\n\r\n")
            header = take(header_end + 4).split(b"\r\n")
            fields = {k.strip().lower(): v.strip() for k, v in (line.split(b":", 1) for line in header[1:] if b":" in line)}
            if header[0] != b"HTTP/1.1 101 Switching Protocols" or fields.get(b"sec-websocket-accept") != expected:
                return False
            banner = bytearray()
            for _ in range(16):
                first, second = take(2)
                if second & 128 or first & 0x70:
                    return False
                length = second & 127
                if length == 126:
                    length = int.from_bytes(take(2), "big")
                elif length == 127:
                    length = int.from_bytes(take(8), "big")
                if length > 65536:
                    return False
                payload = take(length)
                opcode = first & 15
                if opcode in (0, 1, 2):
                    banner.extend(payload)
                    if len(banner) >= 12:
                        return bytes(banner[:12]) in (b"RFB 003.003\n", b"RFB 003.007\n", b"RFB 003.008\n")
                elif opcode == 8:
                    return False
            return False
    except (OSError, EOFError, TimeoutError, ValueError):
        return False
