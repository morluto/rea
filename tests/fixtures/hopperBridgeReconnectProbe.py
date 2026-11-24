"""Exercise the shipped socket lifecycle with a recording native dispatch port."""
import json
from pathlib import Path
import socket
import sys
import threading
import time
from types import SimpleNamespace

from hopperBridgeFacadeProbe import load_bridge


def probe(path, socket_path, mode):
    bridge = load_bridge(path)
    bridge.update(REA_SOCKET=socket_path, REA_TOKEN="owned-token", REA_RUN_ID="owned-run",
                  REA_RECONNECT_TIMEOUT_SECONDS=0.2)
    requests = []
    entered = threading.Event()
    release = threading.Event()
    health = bridge["_dispatch"]

    def dispatch(method, params):
        requests.append(method)
        if method == "health":
            if mode == "lost-reply" and requests == ["health"]:
                entered.set()
                assert release.wait(2), "Probe never released the blocked reply"
            return health(method, params)
        assert method == "shutdown_document", method
        if mode == "lost-shutdown-reply" and not entered.is_set():
            entered.set()
            assert release.wait(2), "Probe never released shutdown"
        closed = not params.get("unconfirmed", False)
        return {"shutdown": True, "analysis_stopped": True, "document_closed": closed}

    bridge["_dispatch"] = dispatch
    failures = []

    def serve():
        try:
            bridge["_run"]()
        except Exception as error:
            failures.append(repr(error))

    listening = threading.Event()
    first_client_prepared = threading.Event()

    class ProbeListener(socket.socket):
        def listen(self, backlog):
            super().listen(backlog)
            listening.set()
            if mode != "initial-expiry":
                assert first_client_prepared.wait(2), f"{mode}: probe did not prepare the first client"

    bridge["socket"] = SimpleNamespace(
        socket=ProbeListener, AF_UNIX=socket.AF_UNIX,
        SOCK_STREAM=socket.SOCK_STREAM, timeout=socket.timeout,
    )
    worker = threading.Thread(target=serve, daemon=True)
    worker.start()
    assert listening.wait(2), failures

    def connect():
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(2)
        try:
            client.connect(socket_path)
        except OSError:
            client.close()
            raise
        return client, client.makefile("rwb")

    def send(file, method, token="owned-token", params=None):
        file.write((json.dumps({"id": 1, "method": method, "token": token, "params": params or {}}) + "\n").encode())
        file.flush()

    def reply(file):
        while True:
            line = file.readline()
            assert line, "Bridge closed before its reply"
            value = json.loads(line)
            if "event" not in value:
                return value

    def queue_successor(method):
        # Queue the reconnect and its first request before the current
        # connection ends, as for the first client. The bridge's reconnect and
        # unauthenticated-idle budgets then start with the request waiting,
        # so a stalled probe cannot let them expire before it reconnects.
        successor, successor_file = connect()
        send(successor_file, method)
        return successor, successor_file

    def finish(shutdown_count):
        worker.join(2)
        assert not worker.is_alive(), f"{mode}: bridge pinned its execution thread"
        assert not failures, failures
        assert not Path(socket_path).exists(), "Bridge retained its closed listener"
        assert requests.count("shutdown_document") == shutdown_count
        return {"mode": mode, "requests": requests, "listener_removed": True, "thread_released": True}

    if mode == "initial-expiry":
        return finish(0)

    # The first accept budget starts only after the fixture has queued its
    # first connection. The shipped bridge still owns all accept/read deadlines.
    client, file = connect()
    if mode == "silent-expiry":
        first_client_prepared.set()
        # connect() can finish while the peer is still in the listen backlog.
        # Observe the bridge expiring the silent connection before waiting
        # for its separate reconnect grace period to release the listener.
        with client, file:
            client.settimeout(5)
            assert file.read(1) == b"", "Silent bridge connection did not close without a reply"
            return finish(0)
    send(file, "health", "foreign-token" if mode == "unauthorized" else "owned-token")
    first_client_prepared.set()
    # A rejected connection keeps the bridge's unauthenticated-idle budget, so
    # it can expire while the probe reads the rejection. Queue its successor
    # first, so that expiry and the reconnect budget both find it waiting.
    rejected_successor = queue_successor("health") if mode == "unauthorized" else None
    if mode == "lost-reply":
        assert entered.wait(2)
    elif mode == "unauthorized":
        assert reply(file)["error"]["type"] == "authorization"
    else:
        assert reply(file)["result"]["run_id"] == "owned-run"
    if mode == "lost-shutdown-reply":
        send(file, "shutdown_document")
        assert entered.wait(2)
        successor, successor_file = queue_successor("shutdown_document")
        client.shutdown(socket.SHUT_RDWR)
        file.close()
        client.close()
        release.set()
        client, file = successor, successor_file
        assert reply(file)["result"]["document_closed"] is True
        file.close()
        client.close()
        return finish(2)
    if mode == "authenticated-idle":
        time.sleep(0.3)
        send(file, "health")
        assert reply(file)["result"]["run_id"] == "owned-run"
    successor = (
        None if mode == "expiry" else rejected_successor or queue_successor("health")
    )
    file.close()
    client.close()
    release.set()
    if successor is not None:
        client, file = successor
        assert reply(file)["result"]["run_id"] == "owned-run"
        send(file, "shutdown_document", params={"unconfirmed": True})
        assert reply(file)["result"]["document_closed"] is False
        send(file, "shutdown_document")
        assert reply(file)["result"]["document_closed"] is True
        file.close()
        client.close()
    return finish(0 if mode == "expiry" else 2)


if __name__ == "__main__":
    print(json.dumps([probe(sys.argv[1], str(Path(sys.argv[2]) / (mode + ".sock")), mode)
                      for mode in ("unauthorized", "disconnect", "lost-reply", "lost-shutdown-reply", "authenticated-idle", "expiry", "initial-expiry", "silent-expiry")]))
