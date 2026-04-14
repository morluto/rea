#!/usr/bin/env python3
"""
NDJSON client for the official HopperMCPServer subprocess.

Handles STDIO communication using NDJSON (newline-delimited JSON) protocol.
Each message is a single JSON object followed by a newline.
"""

import json
import subprocess
import select
import threading
import time
from typing import Any, Optional


class HopperMCPSubprocessClient:
    """Client for communicating with HopperMCPServer via STDIO/NDJSON."""

    def __init__(self, server_path: str = "/Applications/Hopper Disassembler.app/Contents/MacOS/HopperMCPServer"):
        self.server_path = server_path
        self._proc: Optional[subprocess.Popen] = None
        self._next_id = 1
        self._lock = threading.Lock()
        self._server_info: dict = {}

    def start(self) -> dict:
        """Start the subprocess and initialize the connection."""
        if self._proc is not None:
            return self._server_info

        self._proc = subprocess.Popen(
            [self.server_path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0
        )

        self._stderr_thread = threading.Thread(target=self._drain_stderr, daemon=True)
        self._stderr_thread.start()

        time.sleep(0.5)

        self._send({
            "jsonrpc": "2.0",
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "hopper-proxy", "version": "1.0"}
            }
        })
        response = self._recv(timeout=10.0)
        if response and "result" in response:
            self._server_info = response.get("result", {}).get("serverInfo", {})
        else:
            raise RuntimeError(f"Failed to initialize server: {response}")

        time.sleep(1.0)

        return self._server_info

    def _drain_stderr(self):
        """Drain stderr in background thread."""
        while self._proc and self._proc.poll() is None:
            try:
                ready = select.select([self._proc.stderr], [], [], 0.5)
                if ready[0]:
                    line = self._proc.stderr.readline()
                    if not line:
                        break
            except Exception:
                break

    def stop(self):
        """Stop the subprocess."""
        if self._proc:
            self._proc.terminate()
            self._proc.wait(timeout=5)
            self._proc = None

    def _send(self, msg: dict) -> int:
        """Send a JSON-RPC message."""
        with self._lock:
            self._next_id += 1
            msg["id"] = self._next_id
            line = json.dumps(msg) + "\n"
            self._proc.stdin.write(line.encode("utf-8"))
            self._proc.stdin.flush()
            return self._next_id

    def _recv(self, timeout: float = 30.0) -> Optional[dict]:
        """Receive a JSON-RPC response."""
        ready = select.select([self._proc.stdout], [], [], timeout)
        if ready[0]:
            line = self._proc.stdout.readline()
            if line:
                try:
                    return json.loads(line.decode("utf-8"))
                except json.JSONDecodeError:
                    return None
        return None

    def call_tool(self, tool_name: str, arguments: dict = None) -> Any:
        """Call a tool on the server."""
        arguments = arguments or {}
        self._send({
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {
                "name": tool_name,
                "arguments": arguments
            }
        })
        response = self._recv(timeout=30.0)
        if response and "error" in response:
            error_msg = response["error"].get("message", str(response["error"]))
            raise RuntimeError(f"Tool '{tool_name}' error: {error_msg}")
        if response and "result" in response:
            content = response["result"].get("content", [])
            for c in content:
                if c.get("type") == "text":
                    try:
                        return json.loads(c["text"])
                    except (json.JSONDecodeError, TypeError):
                        return c["text"]
            return response["result"]
        return response

    @property
    def server_info(self) -> dict:
        return self._server_info


def test_connection():
    """Test connection to the official server."""
    client = HopperMCPSubprocessClient()
    info = client.start()
    print(f"Connected to {info.get('name', '?')} v{info.get('version', '?')}")

    docs = client.call_tool("list_documents", {})
    print(f"Documents: {docs}")

    client.stop()


if __name__ == "__main__":
    test_connection()
