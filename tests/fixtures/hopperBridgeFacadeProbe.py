"""Exercise the Hopper bridge facade without importing Hopper globals."""

import json
from pathlib import Path
import socket
import sys
import threading


class FakeDocument:
    def __init__(self):
        self.analysis_active = True

    def getDocumentName(self):
        return "fixture"

    def getExecutableFilePath(self):
        return "/tmp/rea-hopper-facade-fixture"

    def getDatabaseFilePath(self):
        return None

    def backgroundProcessActive(self):
        return self.analysis_active

    def getCurrentAddress(self):
        return 0x401000


class FakeDocumentProvider:
    document = FakeDocument()
    current = FakeDocument()
    documents = [document, current]

    @classmethod
    def getAllDocuments(cls):
        return cls.documents

    @classmethod
    def getCurrentDocument(cls):
        return cls.current


class FakeStringSegment:
    def getStringsList(self):
        return [("fixture string", FakeStringAddress())]


class FakeStringAddress:
    def __str__(self):
        return "0x401234"


class FakeStringsDocument:
    def getSegmentsList(self):
        return [FakeStringSegment()]


def load_bridge(path):
    namespace = {
        "__file__": path,
        "__name__": "rea_hopper_bridge",
    }
    source = Path(path).read_text(encoding="utf-8")
    exec(compile(source, path, "exec"), namespace)
    return namespace


def main():
    bridge = load_bridge(sys.argv[1])
    unavailable = None
    try:
        bridge["_api"]()
    except Exception as error:
        unavailable = {
            "type": type(error).__name__,
            "diagnostic_type": bridge["_diagnostic_type"](error),
        }

    bridge["REA_TARGET_PATH"] = "/tmp/rea-hopper-facade-fixture"
    bridge["REA_OWNS_PROCESS_LIFETIME"] = False
    bridge["_configure_hopper_api"](FakeDocumentProvider)
    bridge["_bind_session_document"]()
    strings = bridge["_strings"](FakeStringsDocument())
    current = bridge["_dispatch"]("current_document", {})
    current_address = bridge["_dispatch"]("current_address", {})
    selected = bridge["_session_document"]() is FakeDocumentProvider.current
    retained = bridge["_dispatch"]("shutdown", {})

    analysis_guard = None
    try:
        bridge["_dispatch"]("list_procedures", {})
    except Exception as error:
        analysis_guard = {
            "type": type(error).__name__,
            "diagnostic_type": bridge["_diagnostic_type"](error),
            "message": str(error),
        }

    bridge["REA_TOKEN"] = "probe-token"
    bridge["_dispatch"] = lambda method, params: (
        (_ for _ in ()).throw(RuntimeError("credential=supersecret"))
        if method == "fail"
        else params
    )
    server_socket, client_socket = socket.socketpair()
    worker = threading.Thread(
        target=bridge["_serve_connection"], args=(server_socket,)
    )
    worker.start()
    client_file = client_socket.makefile("rwb")
    client_file.write(
        b'{"id":7,"token":"probe-token","method":"fail","params":{}}\n'
    )
    client_file.flush()
    bridge_messages = [
        json.loads(client_file.readline().decode("utf-8")) for _ in range(3)
    ]
    client_file.write(
        b'{"id":-1,"token":"probe-token","method":"echo","params":{}}\n'
    )
    client_file.flush()
    invalid_id_response = json.loads(client_file.readline().decode("utf-8"))
    client_file.close()
    client_socket.close()
    worker.join(timeout=1)

    print(
        json.dumps(
            {
                "imported_without_hopper": unavailable,
                "current_document": current,
                "current_address": current_address,
                "strings": strings,
                "session_document_reused": selected,
                "shared_document_shutdown": retained,
                "analysis_guard": analysis_guard,
                "bridge_messages": bridge_messages,
                "invalid_id_response": invalid_id_response,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
