"""Repository-owned Hopper adapter. Executed inside Hopper by its documented -Y flag."""

import json
import hmac
import os
import re
import socket

MAX_LINE_BYTES = 10 * 1024 * 1024
BAD_ADDRESSES = (-1, 0xFFFFFFFFFFFFFFFF, None)
_selected_document = None


def _hex(value):
    return "0x%x" % value


def _json_safe(value):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    return str(value)


def _document(name=None):
    global _selected_document
    documents = Document.getAllDocuments()
    if name is not None:
        for candidate in documents:
            if candidate.getDocumentName() == name:
                return candidate
        raise ValueError("Unknown Hopper document")
    if _selected_document is not None:
        for candidate in documents:
            if candidate.getDocumentName() == _selected_document:
                return candidate
    current = Document.getCurrentDocument()
    if current is None:
        raise ValueError("No Hopper document is loaded")
    return current


def _address(document, value=None):
    if value is None:
        return document.getCurrentAddress()
    if not isinstance(value, str):
        raise ValueError("Address must be a string")
    try:
        return int(value, 16)
    except ValueError:
        result = document.getAddressForName(value)
        if result in BAD_ADDRESSES:
            raise ValueError("Unknown Hopper address or name")
        return result


def _segment(document, address):
    result = document.getSegmentAtAddress(address)
    if result is None:
        raise ValueError("Address is outside every segment")
    return result


def _procedure(document, value=None):
    address = document.getCurrentAddress() if value is None else _address(document, value)
    result = _segment(document, address).getProcedureAtAddress(address)
    if result is None:
        raise ValueError("No procedure exists at the requested address")
    return result


def _procedure_name(procedure):
    entry = procedure.getEntryPoint()
    return procedure.getSegment().getNameAtAddress(entry) or _hex(entry)


def _procedure_map(document):
    result = {}
    for segment in document.getSegmentsList():
        for index in range(segment.getProcedureCount()):
            procedure = segment.getProcedureAtIndex(index)
            result[_hex(procedure.getEntryPoint())] = _procedure_name(procedure)
    return result


def _strings(document):
    result = {}
    for segment in document.getSegmentsList():
        for value, address in segment.getStringsList():
            result[_hex(address)] = value
    return result


def _assembly(procedure):
    lines = []
    segment = procedure.getSegment()
    seen = set()
    for block in procedure.basicBlockIterator():
        address = block.getStartingAddress()
        end = block.getEndingAddress()
        while address < end and address not in seen:
            seen.add(address)
            instruction = segment.getInstructionAtAddress(address)
            if instruction is None:
                break
            arguments = [instruction.getFormattedArgument(index) for index in range(instruction.getArgumentCount())]
            suffix = ", ".join(value for value in arguments if value is not None)
            lines.append("%s: %s%s" % (_hex(address), instruction.getInstructionString(), (" " + suffix) if suffix else ""))
            length = instruction.getInstructionLength()
            if length <= 0:
                break
            address += length
    return "\n".join(lines)


def _dispatch(method, params):
    global _selected_document
    if method == "health":
        return {"name": "REA Hopper bridge", "version": "1.0.0"}
    if method == "shutdown":
        return {"shutdown": True}
    if method == "list_documents":
        return [document.getDocumentName() for document in Document.getAllDocuments()]
    if method == "current_document":
        return _document().getDocumentName()
    if method == "set_current_document":
        document = _document(params.get("document"))
        _selected_document = document.getDocumentName()
        return _selected_document

    document = _document(params.get("document"))

    if method == "current_address":
        return _hex(document.getCurrentAddress())
    if method == "current_procedure":
        return _procedure_name(_procedure(document))
    if method == "goto_address":
        address = _address(document, params.get("address"))
        document.moveCursorAtAddress(address)
        return _hex(address)
    if method in ("address_name", "comment", "inline_comment", "xrefs"):
        target = _address(document, params.get("address"))
        segment = _segment(document, target)
        if method == "address_name":
            return segment.getNameAtAddress(target)
        if method == "comment":
            return segment.getCommentAtAddress(target)
        if method == "inline_comment":
            return segment.getInlineCommentAtAddress(target)
        return [_hex(value) for value in segment.getReferencesOfAddress(target)]
    if method in ("next_address", "prev_address"):
        target = _address(document, params.get("address"))
        if method == "next_address":
            result = target + max(1, document.getObjectLength(target))
        else:
            result = document.getInstructionStart(max(0, target - 1))
        if result in BAD_ADDRESSES:
            raise ValueError("No adjacent address")
        return _hex(result)
    if method == "list_segments":
        result = []
        for segment in document.getSegmentsList():
            start = segment.getStartingAddress()
            sections = [{"name": section.getName(), "start": _hex(section.getStartingAddress()), "end": _hex(section.getStartingAddress() + section.getLength())} for section in segment.getSectionsList()]
            result.append({"name": segment.getName(), "start": _hex(start), "end": _hex(start + segment.getLength()), "writable": False, "executable": False, "sections": sections})
        return result
    if method == "list_procedures":
        return _procedure_map(document)
    if method == "list_strings":
        values = _strings(document)
        requested = params.get("address")
        return values if requested is None else values.get(_hex(_address(document, requested)))
    if method == "list_names":
        result = {}
        for segment in document.getSegmentsList():
            for item in segment.getNamedAddresses():
                result[_hex(item)] = segment.getNameAtAddress(item)
        requested = params.get("address")
        return result if requested is None else result.get(_hex(_address(document, requested)))
    if method in ("search_procedures", "search_strings"):
        flags = 0 if params.get("case_sensitive", False) else re.IGNORECASE
        expression = re.compile(params["pattern"], flags)
        values = _procedure_map(document) if method == "search_procedures" else _strings(document)
        return {key: value for key, value in values.items() if expression.search(value)}
    if method.startswith("procedure_"):
        procedure = _procedure(document, params.get("procedure"))
        if method == "procedure_address":
            return _hex(procedure.getEntryPoint())
        if method == "procedure_assembly":
            return _assembly(procedure)
        if method == "procedure_pseudo_code":
            return procedure.decompile()
        if method == "procedure_callers":
            return [_procedure_name(item) for item in procedure.getAllCallerProcedures()]
        if method == "procedure_callees":
            return [_procedure_name(item) for item in procedure.getAllCalleeProcedures()]
        if method == "procedure_info":
            blocks = list(procedure.basicBlockIterator())
            length = sum(max(0, block.getEndingAddress() - block.getStartingAddress()) for block in blocks)
            return {"name": _procedure_name(procedure), "entrypoint": _hex(procedure.getEntryPoint()), "basicblock_count": procedure.getBasicBlockCount(), "length": length, "signature": procedure.signatureString(), "locals": procedure.getLocalVariableList()}
    if method == "set_address_name":
        address = _address(document, params.get("address"))
        return document.setNameAtAddress(address, params["name"])
    if method == "set_addresses_names":
        return {key: document.setNameAtAddress(_address(document, key), value) for key, value in params["names"].items()}
    if method in ("set_comment", "set_inline_comment"):
        address = _address(document, params.get("address"))
        segment = _segment(document, address)
        setter = segment.setCommentAtAddress if method == "set_comment" else segment.setInlineCommentAtAddress
        getter = segment.getCommentAtAddress if method == "set_comment" else segment.getInlineCommentAtAddress
        setter(address, params["comment"])
        return getter(address) == params["comment"]
    if method == "list_bookmarks":
        return [{"address": _hex(item), "name": document.getBookmarkName(item)} for item in document.getBookmarks()]
    if method == "set_bookmark":
        address = _address(document, params.get("address"))
        document.setBookmarkAtAddress(address, params.get("name"))
        return document.hasBookmarkAtAddress(address)
    if method == "unset_bookmark":
        address = _address(document, params.get("address"))
        document.removeBookmarkAtAddress(address)
        return not document.hasBookmarkAtAddress(address)
    raise ValueError("Unknown bridge method")


def _serve_connection(connection):
    file = connection.makefile("rwb")
    while True:
        line = file.readline(MAX_LINE_BYTES + 1)
        if not line or len(line) > MAX_LINE_BYTES:
            break
        request_id = None
        should_stop = False
        try:
            request = json.loads(line.decode("utf-8"))
            if set(request) != {"id", "token", "method", "params"}:
                raise ValueError("Invalid bridge request shape")
            request_id = request["id"]
            if not isinstance(request["token"], str) or not hmac.compare_digest(request["token"], REA_TOKEN):
                raise PermissionError("Invalid bridge capability")
            result = _dispatch(request["method"], request["params"])
            should_stop = request["method"] == "shutdown"
            response = {"id": request_id, "result": _json_safe(result)}
        except Exception as error:
            response = {"id": request_id if isinstance(request_id, int) else 0, "error": {"code": -32000, "message": str(error)[:512]}}
        file.write((json.dumps(response, separators=(",", ":")) + "\n").encode("utf-8"))
        file.flush()
        if should_stop:
            break
    file.close()
    connection.close()


def _run():
    if os.path.exists(REA_SOCKET):
        os.unlink(REA_SOCKET)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(REA_SOCKET)
    os.chmod(REA_SOCKET, 0o600)
    server.listen(1)
    try:
        connection, _ = server.accept()
        _serve_connection(connection)
    finally:
        server.close()
        if os.path.exists(REA_SOCKET):
            os.unlink(REA_SOCKET)


# Hopper's public objects are bound to its dedicated Python execution thread.
# Keep dispatch on that thread; moving calls to an arbitrary worker can deadlock.
_run()
