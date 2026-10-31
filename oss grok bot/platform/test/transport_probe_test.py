"""Real local socket fixture, not a Linux Docker or x11vnc conformance test."""
import base64
import hashlib
import importlib.util
from pathlib import Path
import socket
import threading
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("transport", Path(__file__).resolve().parents[1] / "computer/transport.py")
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)


class Probe(unittest.TestCase):
    def check_response(self, banner, valid_accept=True):
        server = socket.socket()
        server.bind(("127.0.0.1", 0))
        server.listen()
        address = server.getsockname()
        def respond():
            with server, server.accept()[0] as connection:
                data = b""
                while b"\r\n\r\n" not in data:
                    data += connection.recv(4096)
                key = next(line.split(b": ", 1)[1] for line in data.split(b"\r\n") if line.startswith(b"Sec-WebSocket-Key:"))
                accept = base64.b64encode(hashlib.sha1(key+b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest()) if valid_accept else b"wrong"
                connection.sendall(b"HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: "+accept+b"\r\n\r\n"+bytes([130,len(banner)])+banner)
        thread = threading.Thread(target=respond)
        thread.start()
        actual_socket = socket.socket
        class Redirect:
            def __enter__(self):
                self.stream = actual_socket()
                return self
            def __exit__(self,*_): self.stream.close()
            def connect(self,_): self.stream.connect(address)
            def __getattr__(self,name): return getattr(self.stream,name)
        with patch.object(transport,"socket",SimpleNamespace(socket=lambda *_:Redirect(),AF_UNIX=0,SOCK_STREAM=0)):
            result = transport.probe_viewer("unused",1)
        thread.join(2)
        return result

    def test_actual_banner_required(self):
        self.assertTrue(self.check_response(b"RFB 003.008\n"))
        self.assertFalse(self.check_response(b"not a viewer"))
        self.assertFalse(self.check_response(b"RFB 003.008\n",False))

    def test_missing_transport(self):
        if hasattr(socket,"AF_UNIX"):
            self.assertFalse(transport.probe_viewer("/nonexistent-workshop-viewer",0.05))
        else:
            # Windows Python has no Unix sockets; exercise the same missing-socket error boundary.
            def absent(*_): raise FileNotFoundError("fixture socket absent")
            with patch.object(transport,"socket",SimpleNamespace(socket=absent,AF_UNIX=0,SOCK_STREAM=0)):
                self.assertFalse(transport.probe_viewer("unused",0.05))

if __name__ == "__main__": unittest.main()
