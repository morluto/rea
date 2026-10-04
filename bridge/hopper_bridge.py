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
from typing import Any, Optional, Protocol, Sequence

BAD_ADDRESSES = (-1, 0xFFFFFFFFFFFFFFFF, None)
_selected_document = None
_rea_session_document = None
_search_inventory_cache = {}
_pseudocode_cache = {}
_hopper_api = None


class HopperDocument(Protocol):
    """Typed minimum used by the provider-neutral Hopper API facade."""

    def getDocumentName(self) -> str: ...

    def getExecutableFilePath(self) -> Optional[str]: ...

    def getDatabaseFilePath(self) -> Optional[str]: ...

    def backgroundProcessActive(self) -> bool: ...


class HopperDocumentProvider(Protocol):
    """Hopper's injected global document provider."""

    @classmethod
    def getAllDocuments(cls) -> Sequence[HopperDocument]: ...

    @classmethod
    def getCurrentDocument(cls) -> Optional[HopperDocument]: ...


class HopperApiFacade:
    """Small injected boundary around Hopper globals for standalone tests."""

    def __init__(self, document_provider: HopperDocumentProvider):
        self._document_provider = document_provider

    def documents(self) -> Sequence[HopperDocument]:
        return self._document_provider.getAllDocuments()

    def current_document(self) -> Optional[HopperDocument]:
        return self._document_provider.getCurrentDocument()

    def require_analysis_complete(
        self, document: HopperDocument, operation: str
    ) -> None:
        if document.backgroundProcessActive():
            raise CapabilityUnavailableError(
                "%s requires completed Hopper background analysis" % operation
            )


def _configure_hopper_api(document_provider):
    """Inject Hopper's document provider or a standalone test facade."""
    global _hopper_api, _rea_session_document
    _hopper_api = HopperApiFacade(document_provider)
    _rea_session_document = None


def _api():
    """Resolve Hopper globals lazily so importing this module needs no Hopper."""
    global _hopper_api
    if _hopper_api is not None:
        return _hopper_api
    document_provider = globals().get("Document")
    if document_provider is None:
        raise CapabilityUnavailableError(
            "Hopper Document API is unavailable outside the Hopper runtime"
        )
    _hopper_api = HopperApiFacade(document_provider)
    return _hopper_api


def _session_document():
    """Return the exact document bound to this authenticated REA session."""
    global _rea_session_document
    documents = _api().documents()
    if _rea_session_document is not None:
        return (
            _rea_session_document
            if any(document is _rea_session_document for document in documents)
            else None
        )
    return _bind_session_document(documents)


def _bind_session_document(documents=None):
    """Bind this bridge to Hopper's current document for its target."""
    global _rea_session_document
    api = _api()
    if documents is None:
        documents = api.documents()
    target = os.path.realpath(REA_TARGET_PATH)

    def matches_target(document):
        paths = (document.getExecutableFilePath(), document.getDatabaseFilePath())
        return any(path and os.path.realpath(path) == target for path in paths)

    current = api.current_document()
    if current is not None and matches_target(current):
        _rea_session_document = current
        return current
    matching = [document for document in documents if matches_target(document)]
    if len(matching) == 1:
        _rea_session_document = matching[0]
        return matching[0]
    if len(matching) > 1:
        raise CapabilityUnavailableError(
            "The REA session document is ambiguous; Hopper did not identify the launched document"
        )
    return None


class CapabilityUnavailableError(Exception):
    """The active Hopper build lacks one admitted public API operation."""


class InvalidRequestError(Exception):
    """Caller input failed bridge request or operation validation."""


EXHAUSTIVE_ANALYSIS_METHODS = frozenset(
    (
        "analyze_function",
        "list_names",
        "list_procedures",
        "list_strings",
        "procedure_address",
        "procedure_assembly",
        "procedure_callees",
        "procedure_callers",
        "procedure_info",
        "procedure_pseudo_code",
        "procedure_references",
        "read_function_instructions",
        "resolve_containing_procedure",
        "search_procedures",
        "search_strings",
    )
)


def _hex(value):
    if not isinstance(value, int) or isinstance(value, bool):
        try:
            value = int(str(value), 16)
        except ValueError as error:
            raise ValueError("Hopper returned a non-hexadecimal address") from error
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
    api = _api()
    documents = api.documents()
    if name is not None:
        matches = [candidate for candidate in documents if candidate.getDocumentName() == name]
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            current = api.current_document()
            if current is not None and current.getDocumentName() == name:
                return current
            raise InvalidRequestError("Hopper document name is ambiguous")
        raise InvalidRequestError("Unknown Hopper document")
    if _selected_document is not None:
        for candidate in documents:
            if candidate.getDocumentName() == _selected_document:
                return candidate
    session_document = _session_document()
    if session_document is not None:
        return session_document
    current = api.current_document()
    if current is None:
        raise CapabilityUnavailableError("No Hopper document is loaded")
    return current


def _address(document, value=None):
    """Resolve hexadecimal addresses first, then fall back to Hopper symbol names."""
    if value is None:
        return document.getCurrentAddress()
    if not isinstance(value, str):
        raise InvalidRequestError("Address must be a string")
    try:
        return int(value, 16)
    except ValueError:
        result = document.getAddressForName(value)
        if result in BAD_ADDRESSES:
            raise InvalidRequestError("Unknown Hopper address or name")
        return result


def _segment(document, address):
    result = document.getSegmentAtAddress(address)
    if result is None:
        raise InvalidRequestError("Address is outside every segment")
    return result


def _procedure(document, value=None):
    address = document.getCurrentAddress() if value is None else _address(document, value)
    result = _segment(document, address).getProcedureAtAddress(address)
    if result is None:
        raise InvalidRequestError("No procedure exists at the requested address")
    return result


def _procedure_name(procedure):
    entry = procedure.getEntryPoint()
    return procedure.getSegment().getNameAtAddress(entry) or _hex(entry)


def _procedure_identity(procedure):
    return {
        "address": _hex(procedure.getEntryPoint()),
        "name": _procedure_name(procedure),
        "classification": None,
    }


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


def _instruction_addresses(procedure):
    result = []
    seen = set()
    segment = procedure.getSegment()
    for block in procedure.basicBlockIterator():
        address = block.getStartingAddress()
        end = block.getEndingAddress()
        while address < end and address not in seen:
            seen.add(address)
            instruction = segment.getInstructionAtAddress(address)
            if instruction is None:
                break
            result.append(address)
            length = instruction.getInstructionLength()
            if length <= 0:
                break
            address += length
    return result


def _procedure_references(document, params):
    procedure = _procedure(document, params.get("procedure"))
    direction = params.get("direction", "outgoing")
    if direction not in ("incoming", "outgoing"):
        raise InvalidRequestError("direction must be incoming or outgoing")
    addresses = _instruction_addresses(procedure)
    edges = set()
    for address in addresses:
        segment = _segment(document, address)
        references = segment.getReferencesFromAddress(address) if direction == "outgoing" else segment.getReferencesOfAddress(address)
        for reference in references:
            edges.add((address, reference) if direction == "outgoing" else (reference, address))
    ordered = sorted(edges)
    items = []
    for source, target in ordered:
        source_procedure, _ = _containing_procedure(document, source)
        target_procedure, _ = _containing_procedure(document, target)
        items.append({
            "source_address": _hex(source),
            "target_address": _hex(target),
            "source_procedure": _procedure_identity(source_procedure) if source_procedure is not None else None,
            "target_procedure": _procedure_identity(target_procedure) if target_procedure is not None else None,
            "kind": _unavailable("Hopper's public Python API does not classify reference kinds"),
        })
    return {
        "procedure": _procedure_identity(procedure), "direction": direction,
        "references": items,
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


def _invalidate_pseudocode(document):
    """Discard cached decompilation after an analysis annotation changes."""
    document_id = id(document)
    for key in list(_pseudocode_cache):
        if key[0] == document_id:
            del _pseudocode_cache[key]


def _pseudocode(document, procedure):
    """Reuse one provider decompilation for repeated bounded projections."""
    key = (id(document), procedure.getEntryPoint())
    if key not in _pseudocode_cache:
        _pseudocode_cache[key] = procedure.decompile()
    return _pseudocode_cache[key]


def _search_inventory(document, kind):
    """Cache an immutable, address-sorted inventory for an unchanged document."""
    key = (id(document), kind)
    inventory = _search_inventory_cache.get(key)
    if inventory is None:
        if kind == "procedure":
            values = _procedure_map(document)
        elif kind == "string":
            values = _strings(document)
        elif kind == "name":
            values = {_hex(address): value for address, value in _name_map(document).items()}
        else:
            raise ValueError("Unknown inventory kind")
        inventory = tuple(sorted(values.items(), key=lambda item: int(item[0], 16)))
        _search_inventory_cache[key] = inventory
    return inventory


def _search_results(document, kind, params):
    pattern = params.get("pattern")
    if not isinstance(pattern, str) or not pattern:
        raise InvalidRequestError("pattern must be a non-empty string")
    mode = params.get("mode", "literal")
    if mode not in ("literal", "regex"):
        raise InvalidRequestError("mode must be literal or regex")
    case_sensitive = params.get("case_sensitive", False)
    if not isinstance(case_sensitive, bool):
        raise InvalidRequestError("case_sensitive must be a boolean")

    if mode == "literal":
        needle = pattern if case_sensitive else pattern.casefold()
        matches = lambda value: needle in (value if case_sensitive else value.casefold())
    else:
        try:
            expression = re.compile(pattern, 0 if case_sensitive else re.IGNORECASE)
        except (re.error, OverflowError) as error:
            raise InvalidRequestError("Invalid regex pattern") from error
        matches = lambda value: expression.search(value) is not None

    selected = []
    for item in _search_inventory(document, kind):
        if not matches(item[1]):
            continue
        selected.append(item)
    return [
            {
                "address": address,
                "value": value,
            }
            for address, value in selected
        ]


def _unavailable(reason):
    """Describe evidence the public Hopper API cannot truthfully provide."""
    return {"available": False, "reason": reason}


def _name_map(document):
    result = {}
    for segment in document.getSegmentsList():
        for address in segment.getNamedAddresses():
            name = segment.getNameAtAddress(address)
            if name is not None:
                result[address] = name
    return result


def _render_instruction(segment, address):
    instruction = segment.getInstructionAtAddress(address)
    if instruction is None:
        return None
    arguments = [
        instruction.getFormattedArgument(index)
        for index in range(instruction.getArgumentCount())
    ]
    suffix = ", ".join(value for value in arguments if value is not None)
    return "%s: %s%s" % (
        _hex(address),
        instruction.getInstructionString(),
        (" " + suffix) if suffix else "",
    )


def _assembly(procedure):
    """Render assembly while guarding against malformed instruction cycles."""
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
            line = _render_instruction(segment, address)
            if line is not None:
                lines.append(line)
            length = instruction.getInstructionLength()
            if length <= 0:
                break
            address += length
    return "\n".join(lines)


def _read_function_instructions(document, params):
    """Read all raw instructions without invoking decompilation."""
    procedure = _procedure(document, params.get("procedure"))
    addresses = _instruction_addresses(procedure)
    segment = procedure.getSegment()
    items = []
    for address in addresses:
        line = _render_instruction(segment, address)
        if line is not None:
            items.append(line)
    return {
        "procedure": _procedure_identity(procedure),
        "instructions": items,
        "limitations": [
            "Instruction text and ordering are Hopper-specific representations.",
            "The fast path does not decompile the procedure or scan whole-program names and strings.",
        ],
    }


def _analyze_function(document, params):
    """Collect the complete function dossier for agent callers."""
    procedure = _procedure(document, params.get("procedure"))
    addresses = _instruction_addresses(procedure)
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
    pseudo = _pseudocode(document, procedure) or ""
    assembly_lines = _assembly(procedure).splitlines()
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
    string_map = {
        int(address, 16): value
        for address, value in _search_inventory(document, "string")
    }
    name_map = {
        int(address, 16): value
        for address, value in _search_inventory(document, "name")
    }
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
    return {
        "procedure": {"address": _hex(procedure.getEntryPoint()), "name": _procedure_name(procedure), "classification": None, "signature": procedure.signatureString(), "locals": _procedure_locals(procedure)},
        "pseudocode": pseudo,
        "assembly": assembly_lines,
        "comments": comments,
        "callers": callers, "callees": callees,
        "incoming_references": incoming,
        "outgoing_references": outgoing,
        "referenced_strings": referenced_strings,
        "referenced_names": referenced_names,
        "basic_blocks": blocks,
        "limitations": [
            "Hopper's public Python API does not classify reference kinds.",
            "Hopper's public Python API does not expose equivalent external or thunk classification in this dossier.",
            "Unresolved indirect calls without reported target addresses are not represented as call edges.",
            "Pseudocode and assembly are provider-specific representations, not original source.",
        ],
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
        if method == "shutdown" and not REA_OWNS_PROCESS_LIFETIME:
            return {
                "shutdown": True,
                "analysis_stopped": not document.backgroundProcessActive(),
                "document_closed": False,
                "document_retained": True,
            }
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
    if method in EXHAUSTIVE_ANALYSIS_METHODS:
        _api().require_analysis_complete(document, method)

    if method == "analyze_function":
        return _analyze_function(document, params)
    if method == "read_function_instructions":
        return _read_function_instructions(document, params)
    if method == "read_bytes":
        length = params.get("length", 256)
        if isinstance(length, bool) or not isinstance(length, int):
            raise InvalidRequestError("Byte-read length must be an integer")
        if length < 1:
            raise InvalidRequestError("Byte-read length must be at least 1")
        reader = getattr(document, "readBytes", None)
        if not callable(reader):
            raise CapabilityUnavailableError(
                "Hopper's public Python API does not expose readBytes"
            )
        address = _address(document, params.get("address"))
        value = reader(address, length)
        if not isinstance(value, (bytes, bytearray)):
            raise CapabilityUnavailableError(
                "Hopper's public Python API returned an unsupported byte representation"
            )
        data = bytes(value)
        return {
            "address": _hex(address),
            "requested_bytes": length,
            "returned_bytes": len(data),
            "bytes_hex": data.hex(),
            "complete": len(data) == length,
        }
    if method == "address_to_file_offset":
        mapper = getattr(document, "getFileOffsetFromAddress", None)
        if not callable(mapper):
            raise CapabilityUnavailableError(
                "Hopper's public Python API does not expose getFileOffsetFromAddress"
            )
        address = _address(document, params.get("address"))
        offset = mapper(address)
        if (
            isinstance(offset, bool)
            or not isinstance(offset, int)
            or offset in BAD_ADDRESSES
            or offset < 0
        ):
            raise InvalidRequestError("Address has no authoritative file-offset mapping")
        return {"address": _hex(address), "file_offset": offset}
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
            raise InvalidRequestError("No adjacent address")
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
        return [{"address": address, "value": value} for address, value in _search_inventory(document, "procedure")]
    if method == "list_strings":
        values = dict(_search_inventory(document, "string"))
        requested = params.get("address")
        if requested is not None:
            key = _hex(_address(document, requested))
            values = {key: values[key]} if key in values else {}
        return [{"address": address, "value": value} for address, value in values.items()]
    if method == "list_names":
        result = dict(_search_inventory(document, "name"))
        requested = params.get("address")
        if requested is not None:
            key = _hex(_address(document, requested))
            result = {key: result[key]} if key in result else {}
        return [{"address": address, "value": value} for address, value in result.items()]
    if method in ("search_procedures", "search_strings"):
        kind = "procedure" if method == "search_procedures" else "string"
        return _search_results(document, kind, params)
    if method.startswith("procedure_"):
        procedure = _procedure(document, params.get("procedure"))
        if method == "procedure_address":
            return _hex(procedure.getEntryPoint())
        if method == "procedure_assembly":
            return _assembly(procedure)
        if method == "procedure_pseudo_code":
            return _pseudocode(document, procedure)
        if method == "procedure_callers":
            return sorted((_hex(item.getEntryPoint()) for item in procedure.getAllCallerProcedures()), key=lambda value: int(value, 16))
        if method == "procedure_callees":
            return sorted((_hex(item.getEntryPoint()) for item in procedure.getAllCalleeProcedures()), key=lambda value: int(value, 16))
        if method == "procedure_info":
            blocks = list(procedure.basicBlockIterator())
            length = sum(max(0, block.getEndingAddress() - block.getStartingAddress()) for block in blocks)
            return {"name": _procedure_name(procedure), "entrypoint": _hex(procedure.getEntryPoint()), "basicblock_count": procedure.getBasicBlockCount(), "length": length, "signature": procedure.signatureString(), "locals": _procedure_locals(procedure), "classification": None}
    if method == "set_address_name":
        address = _address(document, params.get("address"))
        try:
            result = document.setNameAtAddress(address, params["name"])
        finally:
            _invalidate_search_inventory(document)
            _invalidate_pseudocode(document)
        return result
    if method == "set_addresses_names":
        try:
            result = {key: document.setNameAtAddress(_address(document, key), value) for key, value in params["names"].items()}
        finally:
            _invalidate_search_inventory(document)
            _invalidate_pseudocode(document)
        return result
    if method in ("set_comment", "set_inline_comment"):
        address = _address(document, params.get("address"))
        segment = _segment(document, address)
        setter = segment.setCommentAtAddress if method == "set_comment" else segment.setInlineCommentAtAddress
        getter = segment.getCommentAtAddress if method == "set_comment" else segment.getInlineCommentAtAddress
        setter(address, params["comment"])
        _invalidate_pseudocode(document)
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
    raise InvalidRequestError("Unknown bridge method")


def _serve_connection(connection):
    """Serve one capability-authenticated NDJSON connection."""
    file = connection.makefile("rwb")
    while True:
        line = file.readline()
        if not line:
            break
        request_id = None
        authenticated = False
        should_stop = False
        try:
            try:
                request = json.loads(line.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise InvalidRequestError("Invalid bridge request JSON") from error
            if not isinstance(request, dict) or set(request) != {"id", "token", "method", "params"}:
                raise InvalidRequestError("Invalid bridge request shape")
            request_id = request["id"]
            if isinstance(request_id, bool) or not isinstance(request_id, int) or request_id < 0:
                raise InvalidRequestError("Invalid bridge request id")
            if (
                not isinstance(request["method"], str) or not request["method"]
                or not isinstance(request["params"], dict)
            ):
                raise InvalidRequestError("Invalid bridge method or parameters")
            if (
                not isinstance(request["token"], str) or not request["token"].isascii()
                or not hmac.compare_digest(request["token"], REA_TOKEN)
            ):
                raise PermissionError("Invalid bridge capability")
            authenticated = True
            _write_message(file, {"id": request_id, "event": {
                "type": "progress",
                "phase": "hopper_bridge",
                "completed": 0,
                "total": 1,
                "message": "Hopper bridge started request",
            }})
            result = _dispatch(request["method"], request["params"])
            should_stop = request["method"] == "shutdown_document" or (
                request["method"] == "shutdown" and not result.get("cleanup_required", False)
            )
            safe_result = _json_safe(result)
            _write_message(file, {"id": request_id, "event": {
                "type": "progress",
                "phase": "hopper_bridge",
                "completed": 1,
                "total": 1,
                "message": "Hopper bridge completed request",
                "terminal": True,
            }})
            response = {"id": request_id, "result": safe_result}
        except Exception as error:
            diagnostic = _safe_diagnostic(error)
            if authenticated:
                _write_message(file, {"id": request_id, "event": {
                    "type": "diagnostic",
                    "error": diagnostic,
                }})
            response_id = request_id if (
                isinstance(request_id, int)
                and not isinstance(request_id, bool)
                and request_id >= 0
            ) else 0
            response = {"id": response_id, "error": diagnostic}
        _write_message(file, response)
        if should_stop:
            break
    file.close()
    connection.close()


def _write_message(file, message):
    """Write and flush one compact bridge message."""
    file.write((json.dumps(message, separators=(",", ":")) + "\n").encode("utf-8"))
    file.flush()


def _diagnostic_type(error):
    if isinstance(error, CapabilityUnavailableError):
        return "capability_unavailable"
    if isinstance(error, PermissionError):
        return "authorization"
    if isinstance(error, InvalidRequestError):
        return "invalid_request"
    return "bridge_exception"


def _safe_diagnostic(error):
    """Project one exception without retaining provider or credential text."""
    diagnostic_type = _diagnostic_type(error)
    if diagnostic_type == "capability_unavailable":
        message = str(error)
    elif diagnostic_type == "authorization":
        message = "Invalid bridge capability"
    elif diagnostic_type == "invalid_request":
        message = "Invalid Hopper bridge request"
    else:
        message = "%s: Hopper bridge operation failed" % type(error).__name__
    return {"code": -32000, "message": message, "type": diagnostic_type}


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
# Keep dispatch on that thread; moving calls to a worker can deadlock.
if __name__ == "__main__":
    _bind_session_document()
    _run()
