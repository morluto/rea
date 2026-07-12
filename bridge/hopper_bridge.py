"""Authenticated REA adapter executed on Hopper's dedicated Python thread.

The bootstrap injects ``REA_SOCKET`` and a random ``REA_TOKEN`` before executing
this file with Hopper's supported ``--python`` launcher option. Keep all Hopper
API access on this thread: moving dispatch to a worker can deadlock Hopper.
"""

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
    """Project Hopper-specific Python values into the JSON protocol boundary."""
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    return str(value)


def _document(name=None):
    """Resolve an explicit or session-selected document without changing Hopper UI."""
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
    """Resolve hexadecimal addresses first, then fall back to Hopper symbol names."""
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


def _procedure_identity(procedure):
    return {"address": _hex(procedure.getEntryPoint()), "name": _procedure_name(procedure)}


def _containing_procedure(document, address):
    segment = document.getSegmentAtAddress(address)
    if segment is None:
        return None, "outside_segments"
    procedure = segment.getProcedureAtAddress(address)
    return (procedure, None) if procedure is not None else (None, "not_in_procedure")


def _instruction_addresses(procedure, limit):
    result = []
    seen = set()
    segment = procedure.getSegment()
    truncated = False
    for block in procedure.basicBlockIterator():
        address = block.getStartingAddress()
        end = block.getEndingAddress()
        while address < end and address not in seen:
            if len(result) >= limit:
                truncated = True
                return result, truncated
            seen.add(address)
            instruction = segment.getInstructionAtAddress(address)
            if instruction is None:
                break
            result.append(address)
            length = instruction.getInstructionLength()
            if length <= 0:
                break
            address += length
    return result, truncated


def _procedure_references(document, params):
    procedure = _procedure(document, params.get("procedure"))
    direction = params.get("direction", "outgoing")
    offset = params.get("offset", 0)
    limit = params.get("limit", 100)
    max_instructions = params.get("max_instructions", 500)
    if direction not in ("incoming", "outgoing"):
        raise ValueError("direction must be incoming or outgoing")
    if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
        raise ValueError("offset must be a non-negative integer")
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 500:
        raise ValueError("limit must be an integer between 1 and 500")
    if not isinstance(max_instructions, int) or isinstance(max_instructions, bool) or max_instructions < 1 or max_instructions > 5000:
        raise ValueError("max_instructions must be an integer between 1 and 5000")
    addresses, scan_truncated = _instruction_addresses(procedure, max_instructions)
    edges = set()
    for address in addresses:
        segment = _segment(document, address)
        references = segment.getReferencesFromAddress(address) if direction == "outgoing" else segment.getReferencesOfAddress(address)
        for reference in references:
            edges.add((address, reference) if direction == "outgoing" else (reference, address))
    ordered = sorted(edges)
    items = []
    selected = ordered[offset:offset + limit]
    for source, target in selected:
        source_procedure, _ = _containing_procedure(document, source)
        target_procedure, _ = _containing_procedure(document, target)
        items.append({
            "source_address": _hex(source),
            "target_address": _hex(target),
            "source_procedure": _procedure_identity(source_procedure) if source_procedure is not None else None,
            "target_procedure": _procedure_identity(target_procedure) if target_procedure is not None else None,
            "kind": _unavailable("Hopper's public Python API does not classify reference kinds"),
        })
    next_offset = offset + len(selected)
    has_more = next_offset < len(ordered)
    truncated = scan_truncated or has_more
    return {
        "procedure": _procedure_identity(procedure), "direction": direction,
        "references": {"items": items, "total": None if scan_truncated else len(ordered), "returned": len(items), "truncated": truncated, "next_offset": next_offset if has_more and not scan_truncated else None},
        "instructions_scanned": len(addresses), "instruction_scan_truncated": scan_truncated,
    }


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


def _page(values, offset, limit):
    """Return one deterministically address-sorted page without crossing an unbounded map."""
    if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
        raise ValueError("offset must be a non-negative integer")
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 500:
        raise ValueError("limit must be an integer between 1 and 500")
    ordered = sorted(values.items(), key=lambda item: int(item[0], 16))
    selected = ordered[offset:offset + limit]
    total = len(ordered)
    next_offset = offset + len(selected)
    has_more = next_offset < total
    return {
        "items": [{"address": address, "value": value} for address, value in selected],
        "offset": offset,
        "limit": limit,
        "total": total,
        "next_offset": next_offset if has_more else None,
        "has_more": has_more,
    }


def _unavailable(reason):
    """Describe evidence the public Hopper API cannot truthfully provide."""
    return {"available": False, "reason": reason}


def _assembly(procedure, limit=None):
    """Render bounded assembly while guarding against malformed instruction cycles."""
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
            if limit is not None and len(lines) >= limit:
                return "\n".join(lines)
            length = instruction.getInstructionLength()
            if length <= 0:
                break
            address += length
    return "\n".join(lines)


def _analyze_function(document, params):
    """Collect a bounded, single-pass function dossier for agent callers."""
    procedure = _procedure(document, params.get("procedure"))
    limit = params.get("limit", 100)
    max_chars = params.get("max_pseudocode_chars", 20000)
    max_instructions = params.get("max_instructions", 500)
    if not isinstance(limit, int) or limit < 1 or limit > 500:
        raise ValueError("limit must be an integer between 1 and 500")
    if not isinstance(max_chars, int) or max_chars < 1 or max_chars > 100000:
        raise ValueError("max_pseudocode_chars must be between 1 and 100000")
    if not isinstance(max_instructions, int) or max_instructions < 1 or max_instructions > 5000:
        raise ValueError("max_instructions must be between 1 and 5000")
    blocks = []
    all_blocks = list(procedure.basicBlockIterator())
    for block in all_blocks[:limit]:
        blocks.append({
            "start": _hex(block.getStartingAddress()),
            "end": _hex(block.getEndingAddress()),
            "successors": _unavailable(
                "Hopper's public Python API does not expose CFG successor edges"
            ),
        })
    pseudo = procedure.decompile() or ""
    assembly_sample = _assembly(procedure, max_instructions + 1).splitlines() if params.get("include_assembly", False) else []
    assembly_truncated = len(assembly_sample) > max_instructions
    assembly = assembly_sample[:max_instructions]
    callers = [_procedure_name(item) for item in procedure.getAllCallerProcedures()]
    callees = [_procedure_name(item) for item in procedure.getAllCalleeProcedures()]
    def bounded(items):
        return {"items": items[:limit], "total": len(items), "returned": min(len(items), limit), "truncated": len(items) > limit, "next_offset": limit if len(items) > limit else None}
    entry = procedure.getEntryPoint()
    segment = procedure.getSegment()
    comments = []
    comment = segment.getCommentAtAddress(entry)
    inline_comment = segment.getInlineCommentAtAddress(entry)
    if comment:
        comments.append({"address": _hex(entry), "kind": "comment", "text": comment})
    if inline_comment:
        comments.append({"address": _hex(entry), "kind": "inline", "text": inline_comment})
    incoming = []
    for candidate in document.getSegmentsList():
        incoming.extend(_hex(value) for value in candidate.getReferencesOfAddress(entry))
    incoming = sorted(set(incoming), key=lambda value: int(value, 16))
    return {
        "procedure": {"address": _hex(procedure.getEntryPoint()), "name": _procedure_name(procedure), "signature": procedure.signatureString(), "locals": _json_safe(procedure.getLocalVariableList())},
        "pseudocode": {"text": pseudo[:max_chars], "total_chars": len(pseudo), "returned_chars": min(len(pseudo), max_chars), "truncated": len(pseudo) > max_chars, "next_offset": max_chars if len(pseudo) > max_chars else None},
        "assembly": {"items": assembly, "total": None if assembly_truncated else len(assembly), "returned": len(assembly), "truncated": assembly_truncated, "next_offset": len(assembly) if assembly_truncated else None},
        "comments": bounded(comments), "callers": bounded(callers), "callees": bounded(callees),
        "incoming_references": bounded(incoming),
        "referenced_strings": _unavailable("Hopper's public API does not expose typed outgoing string references for this traversal"),
        "referenced_names": _unavailable("Hopper's public API does not expose typed outgoing name references for this traversal"),
        "basic_blocks": bounded(blocks),
    }


def _dispatch(method, params):
    """Dispatch only the closed operation set implemented by REA's public tools."""
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

    if method == "analyze_function":
        return _analyze_function(document, params)
    if method == "resolve_containing_procedure":
        address = _address(document, params.get("address"))
        procedure, reason = _containing_procedure(document, address)
        if procedure is None:
            return {"query_address": _hex(address), "found": False, "procedure": None, "reason": reason}
        return {"query_address": _hex(address), "found": True, "procedure": _procedure_identity(procedure)}
    if method == "procedure_references":
        return _procedure_references(document, params)

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
            result.append({
                "name": segment.getName(),
                "start": _hex(start),
                "end": _hex(start + segment.getLength()),
                "writable": None,
                "executable": None,
                "permissions": _unavailable(
                    "Hopper's public Python API does not expose segment permissions"
                ),
                "sections": sections,
            })
        return result
    if method == "list_procedures":
        return _page(_procedure_map(document), params.get("offset", 0), params.get("limit", 100))
    if method == "list_strings":
        values = _strings(document)
        requested = params.get("address")
        if requested is not None:
            key = _hex(_address(document, requested))
            values = {key: values[key]} if key in values else {}
        return _page(values, params.get("offset", 0), params.get("limit", 100))
    if method == "list_names":
        result = {}
        for segment in document.getSegmentsList():
            for item in segment.getNamedAddresses():
                result[_hex(item)] = segment.getNameAtAddress(item)
        requested = params.get("address")
        if requested is not None:
            key = _hex(_address(document, requested))
            result = {key: result[key]} if key in result else {}
        return _page(result, params.get("offset", 0), params.get("limit", 100))
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
    """Serve one size-bounded, capability-authenticated NDJSON connection."""
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
    """Own a permission-restricted, single-client Unix socket for this bridge."""
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
