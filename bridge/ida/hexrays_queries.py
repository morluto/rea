"""Read-only REA queries for the Hex-Rays IDA MCP's execute_python tool.

REA sends this module followed by one `_rea_query(tool, arguments_json)`
expression. Each query answers in the database-supervisor reply shape that
REA's headless IDA profile already validates, so the TypeScript adapter owns
interpretation while this module only observes the database. Nothing here
renames, retypes, patches, saves, or navigates.

Addresses cross the boundary as hexadecimal strings: REA decodes JSON numbers
as doubles, which cannot represent every 64-bit address exactly.
"""

import json
import re

import ida_auto
import ida_funcs
import ida_hexrays
import ida_idaapi
import ida_idp
import ida_lines
import ida_loader
import ida_nalt
import ida_name
import ida_segment
import ida_typeinf
import ida_ua
import ida_xref
import idautils
import idc

_BADADDR = ida_idaapi.BADADDR
_HEX_ADDRESS = re.compile(r"^0x[0-9a-f]+$", re.IGNORECASE)

# Paged reads rebuild their snapshot at offset 0, so one enumeration observes
# one consistent list. REA finishes each enumeration before starting another,
# so the lease retains only the most recent snapshot.
_rea_pages = globals().setdefault("_rea_pages", {})


def _hex(ea):
    return f"0x{ea:x}"


def _function(f):
    name = ida_funcs.get_func_name(f.start_ea) or f"sub_{f.start_ea:X}"
    return {"addr": _hex(f.start_ea), "name": name, "size": _hex(f.size())}


def _address(text):
    return int(text, 16) if _HEX_ADDRESS.match(text) else None


def _entry(text):
    """The function whose entry is exactly `text`, or None."""
    ea = _address(text)
    f = None if ea is None else ida_funcs.get_func(ea)
    return f if f is not None and f.start_ea == ea else None


def _snapshot(key, offset, build):
    if offset == 0 or key not in _rea_pages:
        _rea_pages.clear()
        _rea_pages[key] = build()
    return _rea_pages[key]


def _cursor(end, total):
    return {"next": end} if end < total else {"done": True}


def health():
    return {
        "status": "ok",
        "input_path": ida_nalt.get_input_file_path(),
        "input_sha256": (ida_nalt.retrieve_input_file_sha256() or b"").hex() or None,
        "idb_path": ida_loader.get_path(ida_loader.PATH_TYPE_IDB) or None,
        "imagebase": _hex(ida_nalt.get_imagebase()),
        "auto_analysis_ready": bool(ida_auto.auto_is_ok()),
        "module": ida_nalt.get_root_filename() or "",
    }


def list_funcs(queries):
    offset, count = queries["offset"], queries["count"]
    total = ida_funcs.get_func_qty()
    end = min(offset + count, total)
    data = [_function(ida_funcs.getn_func(i)) for i in range(offset, end)]
    return [{"data": data, "next_offset": end if end < total else None}]


def _lookup(query):
    ea = _address(query)
    if ea is None:
        ea = ida_name.get_name_ea(_BADADDR, query)
        if ea == _BADADDR:
            return {"query": query, "fn": None, "error": "Not found"}
    f = ida_funcs.get_func(ea)
    if f is None:
        return {"query": query, "fn": None, "error": "Not a function"}
    return {"query": query, "fn": _function(f), "error": None}


def lookup_funcs(queries):
    return [_lookup(query) for query in queries]


def find_regex(pattern, offset, limit):
    def build():
        matcher = re.compile(pattern)
        return [
            {"addr": _hex(item.ea), "string": text}
            for item in idautils.Strings()
            if matcher.search(text := str(item))
        ]

    matches = _snapshot(("strings", pattern), offset, build)
    end = min(offset + limit, len(matches))
    return {"matches": matches[offset:end], "cursor": _cursor(end, len(matches))}


def decompile(addr, offset, max_lines):
    f = _entry(addr)
    if f is None:
        return {"code": None, "error": "Not a function", "cursor": {"done": True}}

    def build():
        if not ida_hexrays.init_hexrays_plugin():
            return "Hex-Rays decompiler is unavailable for this database"
        try:
            cfunc = ida_hexrays.decompile(f.start_ea)
        except ida_hexrays.DecompilationFailure as failure:
            return str(failure) or "Decompilation failed"
        if cfunc is None:
            return "Decompilation failed"
        return [ida_lines.tag_remove(line.line) for line in cfunc.get_pseudocode()]

    lines = _snapshot(("decompile", f.start_ea), offset, build)
    if isinstance(lines, str):
        return {"code": None, "error": lines, "cursor": {"done": True}}
    end = min(offset + max_lines, len(lines))
    return {
        "code": "\n".join(lines[offset:end]),
        "cursor": _cursor(end, len(lines)),
        "line_count": end - offset,
        "total_lines": len(lines),
    }


def _signature(ea):
    tif = ida_typeinf.tinfo_t()
    if not ida_nalt.get_tinfo(tif, ea) and (
        ida_typeinf.guess_tinfo(tif, ea) != ida_typeinf.GUESS_FUNC_OK
    ):
        return {}
    details = ida_typeinf.func_type_data_t()
    if not tif.get_func_details(details):
        return {}
    return {
        "return_type": str(details.rettype),
        "arguments": [
            {"name": arg.name or f"a{index + 1}", "type": str(arg.type)}
            for index, arg in enumerate(details)
        ],
    }


def disasm(addr, offset, max_instructions):
    f = _entry(addr)
    if f is None:
        return {"asm": None, "error": "Not a function", "cursor": {"done": True}}
    heads = _snapshot(
        ("disasm", f.start_ea),
        offset,
        lambda: [ea for ea in idautils.FuncItems(f.start_ea) if idc.is_code(idc.get_full_flags(ea))],
    )
    end = min(offset + max_instructions, len(heads))
    asm = {
        "name": _function(f)["name"],
        "start_ea": _hex(f.start_ea),
        "lines": [
            {
                "addr": _hex(ea),
                "instruction": ida_lines.generate_disasm_line(ea, ida_lines.GENDSM_REMOVE_TAGS),
            }
            for ea in heads[offset:end]
        ],
        **(_signature(f.start_ea) if offset == 0 else {}),
    }
    return {"asm": asm, "cursor": _cursor(end, len(heads))}


def _imports():
    found = {}

    def record(ea, name, ordinal):
        found[ea] = name or f"ord_{ordinal}"
        return True

    for index in range(ida_nalt.get_import_module_qty()):
        ida_nalt.enum_import_names(index, record)
    return found


def _call_targets(f):
    """Code and pointer targets of every call instruction in `f`, in address order."""
    insn = ida_ua.insn_t()
    for ea in idautils.FuncItems(f.start_ea):
        # Inline data, such as a jump table, can decode as a call and refer to a function.
        if not idc.is_code(idc.get_full_flags(ea)):
            continue
        if not ida_ua.decode_insn(insn, ea) or not ida_idp.is_call_insn(insn):
            continue
        yield from idautils.CodeRefsFrom(ea, False)
        yield from idautils.DataRefsFrom(ea)


def _function_entry_targets(f):
    return sorted(
        {
            to
            for to in _call_targets(f)
            if (callee := ida_funcs.get_func(to)) is not None and callee.start_ea == to
        }
    )


def callees(addrs, limit):
    rows = []
    for addr in addrs:
        f = _entry(addr)
        if f is None:
            rows.append({"callees": None, "error": "Not a function"})
            continue
        imports = _imports()
        found = {}
        for to in _call_targets(f):
            if to in found:
                continue
            callee = ida_funcs.get_func(to)
            if callee is not None:
                # REA resolves an interior target to its containing function.
                found[to] = {"addr": _hex(to), "name": _function(callee)["name"], "type": "internal"}
            else:
                # Imports, pointer slots and code outside every function stay
                # visible by address instead of being dropped.
                name = imports.get(to) or ida_name.get_name(to) or _hex(to)
                found[to] = {"addr": _hex(to), "name": name, "type": "external"}
        items = [found[to] for to in sorted(found)]
        rows.append({"callees": items[:limit], "more": len(items) > limit})
    return rows


def callgraph(roots, max_depth):
    if max_depth != 0:
        raise ValueError("REA requests depth-zero call graphs only")
    rows = []
    for root in roots:
        f = _entry(root)
        if f is None:
            rows.append({"root": root, "error": "Not a function", "nodes": [], "edges": []})
            continue
        targets = _function_entry_targets(f)
        rows.append(
            {
                "root": _hex(f.start_ea),
                "nodes": [{"addr": _hex(f.start_ea), "name": _function(f)["name"]}]
                + [{"addr": _hex(to), "name": ida_funcs.get_func_name(to) or None} for to in targets],
                "edges": [{"from": _hex(f.start_ea), "to": _hex(to), "type": "call"} for to in targets],
                "truncated": False,
                "limit_reason": None,
            }
        )
    return rows


def xrefs_to(addrs, limit):
    rows = []
    for addr in addrs:
        ea = _address(addr)
        if ea is None:
            rows.append({"xrefs": None, "error": "Invalid address"})
            continue
        seen = set()
        items = []
        # Ordinary flow from the previous instruction is not a reference.
        for xref in idautils.XrefsTo(ea, ida_xref.XREF_FAR):
            kind = "code" if xref.iscode else "data"
            if (xref.frm, kind) in seen:
                continue
            seen.add((xref.frm, kind))
            f = ida_funcs.get_func(xref.frm)
            items.append({"addr": _hex(xref.frm), "type": kind, "fn": None if f is None else _function(f)})
            if len(items) > limit:
                break
        rows.append({"xrefs": items[:limit], "more": len(items) > limit})
    return rows


def survey_binary(detail_level):
    if detail_level != "minimal":
        raise ValueError("REA requests the minimal survey only")
    segments = []
    for index in range(ida_segment.get_segm_qty()):
        seg = ida_segment.getnseg(index)
        segments.append({"start": _hex(seg.start_ea), "end": _hex(seg.end_ea), "size": _hex(seg.size())})
    return {"statistics": {"total_segments": len(segments)}, "segments": segments}


_REA_QUERIES = {
    "server_health": health,
    "list_funcs": list_funcs,
    "lookup_funcs": lookup_funcs,
    "find_regex": find_regex,
    "decompile": decompile,
    "disasm": disasm,
    "callees": callees,
    "callgraph": callgraph,
    "xrefs_to": xrefs_to,
    "survey_binary": survey_binary,
}


def _rea_query(tool, arguments):
    return _REA_QUERIES[tool](**json.loads(arguments))
