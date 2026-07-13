"""Authenticated REA adapter executed on Hopper's dedicated Python thread.

The bootstrap injects ``REA_SOCKET`` and a random ``REA_TOKEN`` before executing
this file with Hopper's supported ``--python`` launcher option. Keep all Hopper
API access on this thread: moving dispatch to a worker can deadlock Hopper.
"""

import json
import hmac
import os
import re
import sre_parse
import socket

MAX_LINE_BYTES = 10 * 1024 * 1024
BAD_ADDRESSES = (-1, 0xFFFFFFFFFFFFFFFF, None)
_selected_document = None
_search_inventory_cache = {}
MAX_SEARCH_PATTERN_LENGTH = 256
MAX_SEARCH_VALUE_LENGTH = 4096


def _session_document():
    """Find only the document opened for this authenticated REA session."""
    target = os.path.realpath(REA_TARGET_PATH)
    for document in Document.getAllDocuments():
        paths = (document.getExecutableFilePath(), document.getDatabaseFilePath())
        for path in paths:
            if path and os.path.realpath(path) == target:
                return document
    return None


MAX_REGEX_BACKTRACKING_PATHS = 10000
MAX_REGEX_CANDIDATE_LENGTH = 4096
MAX_REGEX_SEARCH_WORK_UNITS = 1000000


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


def _procedure_locals(procedure):
    """Project opaque Hopper local-variable objects into an exact public shape."""
    return [
        {
            "description": str(local),
            "provenance": "hopper-public-python-api",
        }
        for local in procedure.getLocalVariableList()
    ]


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


def _invalidate_search_inventory(document):
    """Discard derived names after analysis metadata changes."""
    document_id = id(document)
    for key in list(_search_inventory_cache):
        if key[0] == document_id:
            del _search_inventory_cache[key]


def _search_inventory(document, kind):
    """Cache an immutable, address-sorted inventory for an unchanged document."""
    key = (id(document), kind)
    inventory = _search_inventory_cache.get(key)
    if inventory is None:
        values = _procedure_map(document) if kind == "procedure" else _strings(document)
        inventory = tuple(sorted(values.items(), key=lambda item: int(item[0], 16)))
        _search_inventory_cache[key] = inventory
    return inventory


def _checked_regex_paths(left, right, operation):
    """Apply one path-count operation without crossing the static work budget."""
    if operation == "add":
        exceeded = left > MAX_REGEX_BACKTRACKING_PATHS - right
        result = left + right
    else:
        exceeded = right != 0 and left > MAX_REGEX_BACKTRACKING_PATHS // right
        result = left * right
    if exceeded or result > MAX_REGEX_BACKTRACKING_PATHS:
        raise ValueError(
            "Regex exceeds the %d-path backtracking budget"
            % MAX_REGEX_BACKTRACKING_PATHS
        )
    return result


def _repeat_regex_paths(child_paths, minimum, maximum):
    """Count every bounded repetition path, including alternative child paths."""
    paths = 0
    repeated_paths = 1
    for count in range(maximum + 1):
        if count >= minimum:
            paths = _checked_regex_paths(paths, repeated_paths, "add")
        if count < maximum:
            repeated_paths = _checked_regex_paths(
                repeated_paths, child_paths, "multiply"
            )
    return paths


def _validate_regex_class(items):
    """Accept only constant-time character-class operations."""
    allowed = {
        sre_parse.CATEGORY,
        sre_parse.LITERAL,
        sre_parse.NEGATE,
        sre_parse.RANGE,
    }
    if any(operation not in allowed for operation, _ in items):
        raise ValueError("Regex operation is not supported by the bounded matcher")


def _validate_regex_node(node, inside_repeat=False):
    """Return capped path and step bounds for Python regex evaluation."""
    leaf_operations = {
        sre_parse.ANY,
        sre_parse.AT,
        sre_parse.CATEGORY,
        sre_parse.LITERAL,
        sre_parse.NOT_LITERAL,
    }
    forbidden = {
        sre_parse.ASSERT,
        sre_parse.ASSERT_NOT,
        sre_parse.GROUPREF,
        sre_parse.GROUPREF_EXISTS,
    }
    for name in ("GROUPREF_IGNORE", "GROUPREF_LOC_IGNORE", "GROUPREF_UNI_IGNORE"):
        operation = getattr(sre_parse, name, None)
        if operation is not None:
            forbidden.add(operation)
    repeat_tokens = {sre_parse.MAX_REPEAT, sre_parse.MIN_REPEAT}
    possessive = getattr(sre_parse, "POSSESSIVE_REPEAT", None)
    if possessive is not None:
        repeat_tokens.add(possessive)
    atomic = getattr(sre_parse, "ATOMIC_GROUP", None)

    paths = 1
    steps = 0
    for operation, argument in node:
        if operation in forbidden:
            raise ValueError("Regex lookarounds and backreferences are not supported")
        if operation in leaf_operations:
            operation_paths = 1
            operation_steps = 1
        elif operation == sre_parse.IN:
            _validate_regex_class(argument)
            operation_paths = 1
            operation_steps = 1
        elif operation in repeat_tokens:
            if inside_repeat:
                raise ValueError("Nested regex repetitions are not supported")
            minimum, maximum, child = argument
            if maximum == sre_parse.MAXREPEAT or maximum > 1000:
                raise ValueError(
                    "Unbounded or excessive regex repetitions are not supported"
                )
            child_paths, child_steps = _validate_regex_node(child, True)
            operation_paths = _repeat_regex_paths(
                child_paths, minimum, maximum
            )
            operation_steps = maximum * child_steps
        elif operation == sre_parse.SUBPATTERN:
            operation_paths, operation_steps = _validate_regex_node(
                argument[-1], inside_repeat
            )
        elif operation == sre_parse.BRANCH:
            operation_paths = 0
            operation_steps = 0
            for branch in argument[1]:
                branch_paths, branch_steps = _validate_regex_node(
                    branch, inside_repeat
                )
                operation_paths = _checked_regex_paths(
                    operation_paths,
                    branch_paths,
                    "add",
                )
                operation_steps = max(operation_steps, branch_steps)
        elif atomic is not None and operation == atomic:
            operation_paths, operation_steps = _validate_regex_node(
                argument, inside_repeat
            )
        else:
            raise ValueError("Regex operation is not supported by the bounded matcher")
        paths = _checked_regex_paths(paths, operation_paths, "multiply")
        steps += operation_steps
    return paths, steps


def _bounded_regex_matcher(expression, backtracking_paths, steps_per_path):
    """Create a matcher with per-candidate and cumulative work bounds."""
    remaining_work = MAX_REGEX_SEARCH_WORK_UNITS
    work_per_character = backtracking_paths * max(steps_per_path, 1)

    def matches(value):
        nonlocal remaining_work
        if not isinstance(value, str):
            raise ValueError("Regex candidates must be strings")
        if len(value) > MAX_REGEX_CANDIDATE_LENGTH:
            raise ValueError(
                "Regex candidate exceeds the %d-character safety limit"
                % MAX_REGEX_CANDIDATE_LENGTH
            )
        required_work = work_per_character * max(len(value), 1)
        if required_work > remaining_work:
            raise ValueError(
                "Regex search exceeds the %d-unit work budget"
                % MAX_REGEX_SEARCH_WORK_UNITS
            )
        remaining_work -= required_work
        return expression.search(value) is not None

    return matches


def _search_page(document, kind, params):
    pattern = params.get("pattern")
    if not isinstance(pattern, str) or not pattern or len(pattern) > MAX_SEARCH_PATTERN_LENGTH:
        raise ValueError("pattern must contain between 1 and 256 characters")
    mode = params.get("mode", "literal")
    if mode not in ("literal", "regex"):
        raise ValueError("mode must be literal or regex")
    case_sensitive = params.get("case_sensitive", False)
    if not isinstance(case_sensitive, bool):
        raise ValueError("case_sensitive must be a boolean")
    offset = params.get("offset", 0)
    limit = params.get("limit", 100)
    if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
        raise ValueError("offset must be a non-negative integer")
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 100:
        raise ValueError("limit must be an integer between 1 and 100")

    if mode == "literal":
        needle = pattern if case_sensitive else pattern.casefold()
        matches = lambda value: needle in (value if case_sensitive else value.casefold())
    else:
        try:
            parsed = sre_parse.parse(pattern)
            backtracking_paths, steps_per_path = _validate_regex_node(parsed)
            expression = re.compile(pattern, 0 if case_sensitive else re.IGNORECASE)
        except (re.error, OverflowError) as error:
            raise ValueError("Invalid regex pattern") from error
        matches = _bounded_regex_matcher(
            expression, backtracking_paths, steps_per_path
        )

    selected = []
    total = 0
    page_end = offset + limit
    for item in _search_inventory(document, kind):
        if not matches(item[1]):
            continue
        if offset <= total < page_end:
            selected.append(item)
        total += 1
    next_offset = offset + len(selected)
    has_more = next_offset < total
    return {
        "items": [
            {
                "address": address,
                "value": value[:MAX_SEARCH_VALUE_LENGTH],
                "value_truncated": len(value) > MAX_SEARCH_VALUE_LENGTH,
            }
            for address, value in selected
        ],
        "offset": offset,
        "limit": limit,
        "total": total,
        "next_offset": next_offset if has_more else None,
        "has_more": has_more,
    }


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


def _offset(params, name):
    value = params.get(name, 0)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError("%s must be a non-negative integer" % name)
    return value


def _collection_offset(params, name):
    values = params.get("collection_offset", {})
    if not isinstance(values, dict):
        raise ValueError("collection_offset must be an object")
    value = values.get(name, 0)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError("collection_offset.%s must be a non-negative integer" % name)
    return value


def _bounded(items, offset, limit, total=None, scan_truncated=False):
    selected = items[offset:offset + limit]
    known_total = len(items) if total is None and not scan_truncated else total
    has_more = offset + len(selected) < len(items)
    return {
        "items": selected,
        "total": known_total,
        "returned": len(selected),
        "truncated": scan_truncated or has_more,
        "next_offset": offset + len(selected) if has_more else None,
    }


def _name_map(document):
    result = {}
    for segment in document.getSegmentsList():
        for address in segment.getNamedAddresses():
            name = segment.getNameAtAddress(address)
            if name is not None:
                result[address] = name
    return result


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
    pseudocode_offset = _offset(params, "pseudocode_offset")
    assembly_offset = _offset(params, "assembly_offset")
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 500:
        raise ValueError("limit must be an integer between 1 and 500")
    if not isinstance(max_chars, int) or isinstance(max_chars, bool) or max_chars < 1 or max_chars > 100000:
        raise ValueError("max_pseudocode_chars must be between 1 and 100000")
    if not isinstance(max_instructions, int) or isinstance(max_instructions, bool) or max_instructions < 1 or max_instructions > 5000:
        raise ValueError("max_instructions must be between 1 and 5000")
    addresses, instruction_scan_truncated = _instruction_addresses(procedure, max_instructions)
    blocks = []
    all_blocks = list(procedure.basicBlockIterator())
    for block in all_blocks:
        successors = []
        for index in range(block.getSuccessorCount()):
            successor = block.getSuccessorAddressAtIndex(index)
            if successor not in BAD_ADDRESSES:
                successors.append(_hex(successor))
        blocks.append({
            "start": _hex(block.getStartingAddress()),
            "end": _hex(block.getEndingAddress()),
            "successors": sorted(set(successors), key=lambda value: int(value, 16)),
        })
    pseudo = procedure.decompile() or ""
    assembly_lines = _assembly(procedure).splitlines() if params.get("include_assembly", False) else []
    callers = sorted((_procedure_identity(item) for item in procedure.getAllCallerProcedures()), key=lambda item: int(item["address"], 16))
    callees = sorted((_procedure_identity(item) for item in procedure.getAllCalleeProcedures()), key=lambda item: int(item["address"], 16))
    comments = []
    edges = set()
    for address in addresses:
        segment = _segment(document, address)
        comment = segment.getCommentAtAddress(address)
        inline_comment = segment.getInlineCommentAtAddress(address)
        if comment:
            comments.append({"address": _hex(address), "kind": "comment", "text": comment})
        if inline_comment:
            comments.append({"address": _hex(address), "kind": "inline", "text": inline_comment})
        for target in segment.getReferencesFromAddress(address):
            edges.add((address, target))
        for source in segment.getReferencesOfAddress(address):
            edges.add((source, address))
    incoming = []
    outgoing = []
    procedure_addresses = set(addresses)
    for source, target in sorted(edges):
        source_procedure, _ = _containing_procedure(document, source)
        target_procedure, _ = _containing_procedure(document, target)
        item = {
            "source_address": _hex(source),
            "target_address": _hex(target),
            "source_procedure": _procedure_identity(source_procedure) if source_procedure is not None else None,
            "target_procedure": _procedure_identity(target_procedure) if target_procedure is not None else None,
            "kind": _unavailable("Hopper's public Python API does not classify reference kinds"),
        }
        if target in procedure_addresses and source not in procedure_addresses:
            incoming.append(item)
        if source in procedure_addresses:
            outgoing.append(item)
    string_map = {int(address, 16): value for address, value in _strings(document).items()}
    name_map = _name_map(document)
    referenced_strings = []
    referenced_names = []
    for edge in outgoing:
        target = int(edge["target_address"], 16)
        if target in string_map:
            referenced_strings.append({"address": edge["target_address"], "value": string_map[target], "source_address": edge["source_address"]})
        if target in name_map:
            referenced_names.append({"address": edge["target_address"], "value": name_map[target], "source_address": edge["source_address"]})
    comments.sort(key=lambda item: (int(item["address"], 16), item["kind"]))
    referenced_strings.sort(key=lambda item: (int(item["address"], 16), int(item["source_address"], 16)))
    referenced_names.sort(key=lambda item: (int(item["address"], 16), int(item["source_address"], 16)))
    pseudo_text = pseudo[pseudocode_offset:pseudocode_offset + max_chars]
    pseudo_next = pseudocode_offset + len(pseudo_text)
    def collection(name, items, scan_limited=False):
        return _bounded(items, _collection_offset(params, name), limit, None, scan_limited)
    return {
        "procedure": {"address": _hex(procedure.getEntryPoint()), "name": _procedure_name(procedure), "signature": procedure.signatureString(), "locals": _procedure_locals(procedure)},
        "pseudocode": {"text": pseudo_text, "total_chars": len(pseudo), "returned_chars": len(pseudo_text), "truncated": pseudo_next < len(pseudo), "next_offset": pseudo_next if pseudo_next < len(pseudo) else None},
        "assembly": _bounded(assembly_lines, assembly_offset, max_instructions),
        "comments": collection("comments", comments, instruction_scan_truncated),
        "callers": collection("callers", callers), "callees": collection("callees", callees),
        "incoming_references": collection("incoming_references", incoming, instruction_scan_truncated),
        "outgoing_references": collection("outgoing_references", outgoing, instruction_scan_truncated),
        "referenced_strings": collection("referenced_strings", referenced_strings, instruction_scan_truncated),
        "referenced_names": collection("referenced_names", referenced_names, instruction_scan_truncated),
        "basic_blocks": collection("basic_blocks", blocks),
        "instruction_scan": {"scanned": len(addresses), "truncated": instruction_scan_truncated},
    }


def _dispatch(method, params):
    """Dispatch only the closed operation set implemented by REA's public tools."""
    global _selected_document
    if method == "health":
        return {"name": "REA Hopper bridge", "version": "1.0.0", "run_id": REA_RUN_ID}
    if method in ("shutdown", "shutdown_document"):
        document = _session_document()
        if document is None:
            return {"shutdown": True, "analysis_stopped": True, "document_closed": True}
        if document.backgroundProcessActive():
            document.requestBackgroundProcessStop()
        if method == "shutdown" and REA_OWNS_PROCESS_LIFETIME:
            return {
                "shutdown": True,
                "analysis_stopped": not document.backgroundProcessActive(),
                "document_closed": False,
                "cleanup_required": True,
            }
        if document.backgroundProcessActive():
            document.waitForBackgroundProcessToEnd()
        document.closeDocument()
        analysis_stopped = not document.backgroundProcessActive()
        document_closed = _session_document() is None
        return {
            "shutdown": True,
            "analysis_stopped": analysis_stopped,
            "document_closed": document_closed,
        }
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
        permission_limitation = _unavailable(
            "Hopper's public Python API does not expose segment or section permissions"
        )
        for segment in document.getSegmentsList():
            start = segment.getStartingAddress()
            sections = [{
                "name": section.getName(),
                "start": _hex(section.getStartingAddress()),
                "end": _hex(section.getStartingAddress() + section.getLength()),
                "readable": None,
                "writable": None,
                "executable": None,
                "permissions": permission_limitation,
                "provenance": "hopper-public-python-api",
            } for section in segment.getSectionsList()]
            result.append({
                "name": segment.getName(),
                "start": _hex(start),
                "end": _hex(start + segment.getLength()),
                "readable": None,
                "writable": None,
                "executable": None,
                "permissions": permission_limitation,
                "provenance": "hopper-public-python-api",
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
        kind = "procedure" if method == "search_procedures" else "string"
        return _search_page(document, kind, params)
    if method.startswith("procedure_"):
        procedure = _procedure(document, params.get("procedure"))
        if method == "procedure_address":
            return _hex(procedure.getEntryPoint())
        if method == "procedure_assembly":
            return _assembly(procedure)
        if method == "procedure_pseudo_code":
            return procedure.decompile()
        if method == "procedure_callers":
            return sorted((_hex(item.getEntryPoint()) for item in procedure.getAllCallerProcedures()), key=lambda value: int(value, 16))
        if method == "procedure_callees":
            return sorted((_hex(item.getEntryPoint()) for item in procedure.getAllCalleeProcedures()), key=lambda value: int(value, 16))
        if method == "procedure_info":
            blocks = list(procedure.basicBlockIterator())
            length = sum(max(0, block.getEndingAddress() - block.getStartingAddress()) for block in blocks)
            return {"name": _procedure_name(procedure), "entrypoint": _hex(procedure.getEntryPoint()), "basicblock_count": procedure.getBasicBlockCount(), "length": length, "signature": procedure.signatureString(), "locals": _procedure_locals(procedure)}
    if method == "set_address_name":
        address = _address(document, params.get("address"))
        result = document.setNameAtAddress(address, params["name"])
        _invalidate_search_inventory(document)
        return result
    if method == "set_addresses_names":
        result = {key: document.setNameAtAddress(_address(document, key), value) for key, value in params["names"].items()}
        _invalidate_search_inventory(document)
        return result
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
            should_stop = request["method"] == "shutdown_document" or (
                request["method"] == "shutdown" and not result.get("cleanup_required", False)
            )
            response = {"id": request_id, "result": _json_safe(result)}
        except Exception as error:
            response = {"id": request_id if isinstance(request_id, int) else 0, "error": {"code": -32000, "message": str(error)[:512], "type": _diagnostic_type(error)}}
        file.write((json.dumps(response, separators=(",", ":")) + "\n").encode("utf-8"))
        file.flush()
        if should_stop:
            break
    file.close()
    connection.close()


def _diagnostic_type(error):
    if isinstance(error, PermissionError):
        return "authorization"
    if isinstance(error, (ValueError, TypeError, KeyError)):
        return "invalid_request"
    return "bridge_exception"


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
