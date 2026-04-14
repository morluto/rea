#!/usr/bin/env python3
"""
HopperProxyMCP - Proxy server that wraps the official HopperMCPServer and adds RE-specific tools.

Architecture:
    MCP Client ←STDIO→ Our Proxy Server ←STDIO→ Official HopperMCPServer ←XPC→ Hopper.app
"""

import asyncio
import json
from contextlib import asynccontextmanager
from typing import Any, Optional

from fastmcp import FastMCP, Context
from pydantic import Field

try:
    from hopper_client import HopperMCPSubprocessClient
except ImportError:
    from .hopper_client import HopperMCPSubprocessClient


OFFICIAL_SERVER_PATH = "/Applications/Hopper Disassembler.app/Contents/MacOS/HopperMCPServer"

_client: Optional[HopperMCPSubprocessClient] = None


def get_client() -> HopperMCPSubprocessClient:
    global _client
    if _client is None:
        _client = HopperMCPSubprocessClient(OFFICIAL_SERVER_PATH)
        _client.start()
    return _client


@asynccontextmanager
async def lifespan(server: FastMCP):
    global _client
    _client = HopperMCPSubprocessClient(OFFICIAL_SERVER_PATH)
    _client.start()
    yield
    if _client:
        _client.stop()
        _client = None


mcp = FastMCP(
    name="HopperProxyMCP",
    instructions=(
        "This server provides reverse engineering tools for analyzing binaries in Hopper Disassembler. "
        "It wraps the official Hopper MCP server and adds Swift/ObjC-specific analysis tools. "
        "Use binary_overview() first to understand the loaded binary, then swift_classes() or "
        "analyze_swift_types() to explore the type hierarchy, and batch_decompile() or "
        "get_call_graph() for deeper analysis."
    ),
    version="1.0.0",
    mask_error_details=True,
    on_duplicate_tools="error",
    lifespan=lifespan,
)


def _call_official(tool_name: str, arguments: dict = None) -> Any:
    return get_client().call_tool(tool_name, arguments or {})


@mcp.tool(name="address_name")
async def address_name_tool(
    document: Optional[str] = Field(default=None, description="The document name"),
    address: Optional[str] = Field(default=None, description="The address to get the name for"),
) -> str:
    result = _call_official("address_name", {"document": document, "address": address})
    if isinstance(result, dict):
        return json.dumps(result, indent=2, default=str)
    return str(result) if result else "OK"


@mcp.tool(name="comment")
async def comment_tool(
    document: Optional[str] = Field(default=None, description="The document name"),
    address: Optional[str] = Field(default=None, description="The address to get the comment for"),
) -> str:
    result = _call_official("comment", {"document": document, "address": address})
    if isinstance(result, dict):
        return json.dumps(result, indent=2, default=str)
    return str(result) if result else "OK"


@mcp.tool(name="current_address")
async def current_address_tool(
    document: Optional[str] = Field(default=None, description="The document name"),
) -> str:
    result = _call_official("current_address", {"document": document})
    if isinstance(result, dict):
        return json.dumps(result, indent=2, default=str)
    return str(result) if result else "OK"


@mcp.tool(name="current_procedure")
async def current_procedure_tool(
    document: Optional[str] = Field(default=None, description="The document name"),
) -> str:
    result = _call_official("current_procedure", {"document": document})
    if isinstance(result, dict):
        return json.dumps(result, indent=2, default=str)
    return str(result) if result else "OK"


@mcp.tool(name="current_document")
async def current_document_tool() -> str:
    result = _call_official("current_document", {})
    if isinstance(result, dict):
        return json.dumps(result, indent=2, default=str)
    return str(result) if result else "OK"


@mcp.tool(name="goto_address")
async def goto_address_tool(
    address: str = Field(description="The address to go to"),
    document: Optional[str] = Field(default=None, description="The document name"),
) -> str:
    result = _call_official("goto_address", {"address": address, "document": document})
    if isinstance(result, dict):
        return json.dumps(result, indent=2, default=str)
    return str(result) if result else "OK"


@mcp.tool(name="inline_comment")
async def inline_comment_tool(
    document: Optional[str] = Field(default=None, description="The document name"),
    address: Optional[str] = Field(default=None, description="The address to get the inline comment for"),
) -> str:
    result = _call_official("inline_comment", {"document": document, "address": address})
    if isinstance(result, dict):
        return json.dumps(result, indent=2, default=str)
    return str(result) if result else "OK"


@mcp.tool(name="list_bookmarks")
async def list_bookmarks_tool(
    document: Optional[str] = Field(default=None, description="The document name"),
) -> str:
    result = _call_official("list_bookmarks", {"document": document})
    if isinstance(result, dict):
        return json.dumps(result, indent=2, default=str)
    return str(result) if result else "OK"


@mcp.tool(name="list_documents")
async def list_documents_tool() -> str:
    result = _call_official("list_documents", {})
    if isinstance(result, dict):
        return json.dumps(result, indent=2, default=str)
    return str(result) if result else "OK"


@mcp.tool(name="list_names")
async def list_names_tool(
    document: Optional[str] = Field(default=None, description="The document name"),
    address: Optional[str] = Field(default=None, description="The address to start from"),
) -> str:
    result = _call_official("list_names", {"document": document, "address": address})
    if isinstance(result, dict):
        return json.dumps(result, indent=2, default=str)
    return str(result) if result else "OK"


@mcp.tool(name="list_procedures")
async def list_procedures_tool(
    document: Optional[str] = Field(default=None, description="The document name"),
) -> str:
    result = _call_official("list_procedures", {"document": document})
    if isinstance(result, dict):
        return json.dumps(result, indent=2, default=str)
    return str(result) if result else "OK"


@mcp.tool(name="list_segments")
async def list_segments_tool(
    document: Optional[str] = Field(default=None, description="The document name"),
) -> str:
    result = _call_official("list_segments", {"document": document})
    if isinstance(result, dict):
        return json.dumps(result, indent=2, default=str)
    return str(result) if result else "OK"


@mcp.tool(name="list_strings")
async def list_strings_tool(
    document: Optional[str] = Field(default=None, description="The document name"),
    address: Optional[str] = Field(default=None, description="The address to start from"),
) -> str:
    result = _call_official("list_strings", {"document": document, "address": address})
    if isinstance(result, dict):
        return json.dumps(result, indent=2, default=str)
    return str(result) if result else "OK"


@mcp.tool(name="next_address")
async def next_address_tool(
    document: Optional[str] = Field(default=None, description="The document name"),
    address: Optional[str] = Field(default=None, description="The current address"),
) -> str:
    result = _call_official("next_address", {"document": document, "address": address})
    if isinstance(result, dict):
        return json.dumps(result, indent=2, default=str)
    return str(result) if result else "OK"


@mcp.tool(name="prev_address")
async def prev_address_tool(
    document: Optional[str] = Field(default=None, description="The document name"),
    address: Optional[str] = Field(default=None, description="The current address"),
) -> str:
    result = _call_official("prev_address", {"document": document, "address": address})
    if isinstance(result, dict):
        return json.dumps(result, indent=2, default=str)
    return str(result) if result else "OK"


@mcp.tool(name="procedure_address")
async def procedure_address_tool(
    procedure: str = Field(description="The procedure name or address"),
    document: Optional[str] = Field(default=None, description="The document name"),
) -> str:
    result = _call_official("procedure_address", {"procedure": procedure, "document": document})
    if isinstance(result, dict):
        return json.dumps(result, indent=2, default=str)
    return str(result) if result else "OK"


@mcp.tool(name="procedure_assembly")
async def procedure_assembly_tool(
    procedure: str = Field(description="The procedure name or address"),
    document: Optional[str] = Field(default=None, description="The document name"),
) -> str:
    result = _call_official("procedure_assembly", {"procedure": procedure, "document": document})
    if isinstance(result, dict):
        return json.dumps(result, indent=2, default=str)
    return str(result) if result else "OK"


@mcp.tool(name="procedure_callees")
async def procedure_callees_tool(
    procedure: str = Field(description="The procedure name or address"),
    document: Optional[str] = Field(default=None, description="The document name"),
) -> str:
    result = _call_official("procedure_callees", {"procedure": procedure, "document": document})
    if isinstance(result, dict):
        return json.dumps(result, indent=2, default=str)
    elif isinstance(result, list):
        return json.dumps(result, indent=2, default=str)
    return str(result) if result else "OK"


@mcp.tool(name="procedure_callers")
async def procedure_callers_tool(
    procedure: str = Field(description="The procedure name or address"),
    document: Optional[str] = Field(default=None, description="The document name"),
) -> str:
    result = _call_official("procedure_callers", {"procedure": procedure, "document": document})
    if isinstance(result, dict):
        return json.dumps(result, indent=2, default=str)
    elif isinstance(result, list):
        return json.dumps(result, indent=2, default=str)
    return str(result) if result else "OK"


@mcp.tool(name="procedure_info")
async def procedure_info_tool(
    procedure: str = Field(description="The procedure name or address"),
    document: Optional[str] = Field(default=None, description="The document name"),
) -> str:
    result = _call_official("procedure_info", {"procedure": procedure, "document": document})
    if isinstance(result, dict):
        return json.dumps(result, indent=2, default=str)
    return str(result) if result else "OK"


@mcp.tool(name="procedure_pseudo_code")
async def procedure_pseudo_code_tool(
    procedure: str = Field(description="The procedure name or address"),
    document: Optional[str] = Field(default=None, description="The document name"),
) -> str:
    result = _call_official("procedure_pseudo_code", {"procedure": procedure, "document": document})
    if isinstance(result, dict):
        return json.dumps(result, indent=2, default=str)
    return str(result) if result else "OK"


@mcp.tool(name="search_procedures")
async def search_procedures_tool(
    pattern: str = Field(description="The regex pattern to search for"),
    case_sensitive: bool = Field(default=False, description="Whether to match case"),
    document: Optional[str] = Field(default=None, description="The document name"),
) -> str:
    result = _call_official("search_procedures", {"pattern": pattern, "case_sensitive": case_sensitive, "document": document})
    if isinstance(result, dict):
        return json.dumps(result, indent=2, default=str)
    return str(result) if result else "OK"


@mcp.tool(name="search_strings")
async def search_strings_tool(
    pattern: str = Field(description="The regex pattern to search for"),
    case_sensitive: bool = Field(default=False, description="Whether to match case"),
    document: Optional[str] = Field(default=None, description="The document name"),
) -> str:
    result = _call_official("search_strings", {"pattern": pattern, "case_sensitive": case_sensitive, "document": document})
    if isinstance(result, dict):
        return json.dumps(result, indent=2, default=str)
    return str(result) if result else "OK"


@mcp.tool(name="set_address_name")
async def set_address_name_tool(
    address: str = Field(description="The address to name"),
    name: str = Field(description="The name to set"),
    document: Optional[str] = Field(default=None, description="The document name"),
) -> str:
    result = _call_official("set_address_name", {"address": address, "name": name, "document": document})
    return "OK" if result else "OK"


@mcp.tool(name="set_addresses_names")
async def set_addresses_names_tool(
    names: dict = Field(description="A dictionary mapping addresses to names"),
    document: Optional[str] = Field(default=None, description="The document name"),
) -> str:
    result = _call_official("set_addresses_names", {"names": names, "document": document})
    return "OK" if result else "OK"


@mcp.tool(name="set_bookmark")
async def set_bookmark_tool(
    address: str = Field(description="The address to bookmark"),
    name: Optional[str] = Field(default=None, description="The bookmark name"),
    document: Optional[str] = Field(default=None, description="The document name"),
) -> str:
    result = _call_official("set_bookmark", {"address": address, "name": name, "document": document})
    return "OK" if result else "OK"


@mcp.tool(name="set_comment")
async def set_comment_tool(
    address: str = Field(description="The address to comment on"),
    comment: str = Field(description="The comment text"),
    document: Optional[str] = Field(default=None, description="The document name"),
) -> str:
    result = _call_official("set_comment", {"address": address, "comment": comment, "document": document})
    return "OK" if result else "OK"


@mcp.tool(name="set_current_document")
async def set_current_document_tool(
    document: str = Field(description="The document name to set as current"),
) -> str:
    result = _call_official("set_current_document", {"document": document})
    return "OK" if result else "OK"


@mcp.tool(name="set_inline_comment")
async def set_inline_comment_tool(
    address: str = Field(description="The address to inline comment on"),
    comment: str = Field(description="The inline comment text"),
    document: Optional[str] = Field(default=None, description="The document name"),
) -> str:
    result = _call_official("set_inline_comment", {"address": address, "comment": comment, "document": document})
    return "OK" if result else "OK"


@mcp.tool(name="unset_bookmark")
async def unset_bookmark_tool(
    address: str = Field(description="The address to remove bookmark from"),
    document: Optional[str] = Field(default=None, description="The document name"),
) -> str:
    result = _call_official("unset_bookmark", {"address": address, "document": document})
    return "OK" if result else "OK"


@mcp.tool(name="xrefs")
async def xrefs_tool(
    document: Optional[str] = Field(default=None, description="The document name"),
    address: Optional[str] = Field(default=None, description="The address to get xrefs for"),
) -> str:
    result = _call_official("xrefs", {"document": document, "address": address})
    if isinstance(result, dict):
        return json.dumps(result, indent=2, default=str)
    elif isinstance(result, list):
        return json.dumps(result, indent=2, default=str)
    return str(result) if result else "OK"


@mcp.tool(name="swift_classes")
async def swift_classes_tool(
    pattern: str = Field(default="", description="Optional pattern to filter class names"),
) -> str:
    all_procs = _call_official("list_procedures", {}) or {}
    if isinstance(all_procs, dict):
        all_procs = all_procs.get("procedures", all_procs)

    swift_classes = []
    for addr, name in list(all_procs.items())[:5000] if isinstance(all_procs, dict) else []:
        if not isinstance(name, str):
            continue
        if name.startswith("_TtC") or "_TtC" in name:
            if pattern and pattern not in name:
                continue
            swift_classes.append({"address": addr, "name": name})

    result = {
        "count": len(swift_classes),
        "classes": swift_classes[:100],
    }
    return json.dumps(result, indent=2, default=str)


@mcp.tool(name="get_objc_classes")
async def get_objc_classes_tool(
    pattern: str = Field(default="", description="Optional pattern to filter class names"),
) -> str:
    names = _call_official("list_names", {}) or {}
    if isinstance(names, dict):
        names = names.get("names", names)

    objc_classes = []
    seen = set()

    for item in names if isinstance(names, list) else []:
        if not isinstance(item, dict):
            continue
        name = item.get("name", "")
        if not isinstance(name, str):
            continue
        if "OBJC_CLASS" in name or "OBJC_$_CLASS" in name or name.startswith("_OBJC_"):
            if pattern and pattern not in name:
                continue
            addr = item.get("address", "")
            if name not in seen:
                seen.add(name)
                objc_classes.append({"address": addr, "name": name})

    result = {
        "count": len(objc_classes),
        "classes": objc_classes[:100],
    }
    return json.dumps(result, indent=2, default=str)


@mcp.tool(name="get_objc_protocols")
async def get_objc_protocols_tool() -> str:
    names = _call_official("list_names", {}) or {}
    if isinstance(names, dict):
        names = names.get("names", names)

    protocols = []
    seen = set()

    for item in names if isinstance(names, list) else []:
        if not isinstance(item, dict):
            continue
        name = item.get("name", "")
        if not isinstance(name, str):
            continue
        if "OBJC_PROTOCOL" in name or "_TtP" in name:
            if name not in seen:
                seen.add(name)
                protocols.append({"address": item.get("address", ""), "name": name})

    result = {
        "count": len(protocols),
        "protocols": protocols[:100],
    }
    return json.dumps(result, indent=2, default=str)


@mcp.tool(name="batch_decompile")
async def batch_decompile_tool(
    addresses: list[str] = Field(default=[], description="List of procedure addresses to decompile"),
) -> str:
    if not addresses:
        return json.dumps({"error": "No addresses provided"}, indent=2)

    addresses = addresses[:20]

    results = {}
    for addr in addresses:
        try:
            pseudo = _call_official("procedure_pseudo_code", {"procedure": addr})
            results[addr] = pseudo if pseudo else "No output"
        except Exception as e:
            results[addr] = f"Error: {str(e)}"

    return json.dumps(results, indent=2, default=str)


@mcp.tool(name="get_call_graph")
async def get_call_graph_tool(
    address: str = Field(description="Starting address for call graph traversal"),
    direction: str = Field(default="forward", description="Traversal direction: 'forward' (callees) or 'backward' (callers)"),
    depth: int = Field(default=2, description="Maximum traversal depth (1-5)"),
) -> str:
    depth = min(max(1, depth), 5)

    visited = set()
    queue = [(address, 0)]
    graph = {}

    while queue:
        current, current_depth = queue.pop(0)

        if current in visited or current_depth >= depth:
            continue
        visited.add(current)

        if current_depth not in graph:
            graph[current_depth] = []

        tool_name = "procedure_callees" if direction == "forward" else "procedure_callers"
        try:
            callees = _call_official(tool_name, {"procedure": current}) or []
            if isinstance(callees, dict):
                callees = callees.get("callees", callees.get("callers", []))
            graph[current_depth].append({"address": current, "calls": callees})

            if current_depth + 1 < depth:
                for callee in callees if isinstance(callees, list) else []:
                    if callee not in visited:
                        queue.append((callee, current_depth + 1))
        except Exception as e:
            graph[current_depth].append({"address": current, "error": str(e)})

    return json.dumps(graph, indent=2, default=str)


@mcp.tool(name="analyze_swift_types")
async def analyze_swift_types_tool() -> str:
    all_procs = _call_official("list_procedures", {}) or {}
    if isinstance(all_procs, dict):
        all_procs = all_procs.get("procedures", all_procs)

    swift_symbols = {
        "classes": [],
        "structs": [],
        "enums": [],
        "protocols": [],
        "extensions": [],
        "other": [],
    }

    seen = set()

    for addr, name in list(all_procs.items())[:5000] if isinstance(all_procs, dict) else []:
        if not isinstance(name, str) or "_Tt" not in name:
            continue
        if name in seen:
            continue
        seen.add(name)

        entry = {"address": addr, "name": name}

        if name.startswith("_TtC"):
            swift_symbols["classes"].append(entry)
        elif name.startswith("_TtV"):
            swift_symbols["structs"].append(entry)
        elif name.startswith("_TtO"):
            swift_symbols["enums"].append(entry)
        elif name.startswith("_TtP"):
            swift_symbols["protocols"].append(entry)
        elif name.startswith("_TtE"):
            swift_symbols["extensions"].append(entry)
        else:
            swift_symbols["other"].append(entry)

    result = {
        "total": sum(len(v) for v in swift_symbols.values()),
        "categories": {k: {"count": len(v), "items": v[:50]} for k, v in swift_symbols.items()},
    }
    return json.dumps(result, indent=2, default=str)


@mcp.tool(name="find_xrefs_to_name")
async def find_xrefs_to_name_tool(
    name: str = Field(description="Name to search for and get xrefs to"),
) -> str:
    addr_result = _call_official("address_name", {"address": name})
    addr = None

    if isinstance(addr_result, dict):
        addr = addr_result.get("address", addr_result.get("name"))
    elif isinstance(addr_result, str):
        addr = addr_result

    if not addr:
        return json.dumps({"error": f"Could not resolve name: {name}"})

    xrefs = _call_official("xrefs", {"address": addr})

    if isinstance(xrefs, dict):
        pass
    elif isinstance(xrefs, list):
        xrefs = {"xrefs": xrefs}

    return json.dumps(xrefs, indent=2, default=str)


@mcp.tool(name="binary_overview")
async def binary_overview_tool() -> str:
    segments = _call_official("list_segments", {}) or {}
    if isinstance(segments, dict):
        segments = segments.get("segments", segments)

    documents = _call_official("list_documents", {}) or []
    if isinstance(documents, dict):
        documents = documents.get("documents", documents)

    procedures = _call_official("list_procedures", {}) or {}
    if isinstance(procedures, dict):
        procedures = procedures.get("procedures", procedures)
    proc_count = len(procedures) if isinstance(procedures, dict) else "unknown"

    strings = _call_official("list_strings", {}) or {}
    if isinstance(strings, dict):
        strings = strings.get("strings", strings)
    string_count = len(strings) if isinstance(strings, list) else "unknown"

    doc_name = documents[0] if documents else "unknown"

    result = {
        "document": doc_name,
        "segments": [{"name": s.get("name", ""), "start": s.get("start", ""), "end": s.get("end", "")} for s in segments[:10]],
        "segment_count": len(segments) if isinstance(segments, list) else "unknown",
        "procedure_count": proc_count,
        "string_count": string_count,
    }
    return json.dumps(result, indent=2, default=str)


def main():
    mcp.run()


if __name__ == "__main__":
    main()
