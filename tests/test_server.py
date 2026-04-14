#!/usr/bin/env python3
"""
Tests for HopperProxyMCP server with mocked subprocess.
"""

import asyncio
import json
import os
import sys
import pytest
from unittest.mock import MagicMock, patch, AsyncMock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class MockHopperClient:
    def __init__(self, server_path=None):
        self._server_info = {"name": "HopperMCPServer", "version": "0.1.0"}
        self._started = False
        self._call_history = []

    def start(self):
        self._started = True
        return self._server_info

    def stop(self):
        self._started = False

    def call_tool(self, tool_name, arguments=None):
        arguments = arguments or {}
        self._call_history.append({"tool": tool_name, "args": arguments})

        if tool_name == "list_documents":
            return ["test_binary"]
        elif tool_name == "list_segments":
            return [{"name": "__TEXT", "start": "0x100000000", "end": "0x1000e0000"}]
        elif tool_name == "list_procedures":
            return {
                "0x1040f4124": "-[_TtC6Signal29AccountSettingsViewController viewDidLoad]",
                "0x1040f4150": "_TtC6Signal29AccountSettingsViewController"
            }
        elif tool_name == "procedure_pseudo_code":
            return "func viewDidLoad() { self.setup() }"
        elif tool_name == "search_procedures":
            return {"0x1040f4124": "-[_TtC6Signal29AccountSettingsViewController viewDidLoad]"}
        elif tool_name == "procedure_callees":
            return ["0x1040f4160", "0x1040f4170"]
        elif tool_name == "procedure_callers":
            return ["0x1040f4100"]
        elif tool_name == "list_names":
            return [
                {"address": "0x1000a0000", "name": "_OBJC_CLASS_$_SignalAppDelegate"},
                {"address": "0x1000a0010", "name": "_TtC6Signal11AppDelegate"}
            ]
        elif tool_name == "address_name":
            return {"address": "0x1040f4124", "name": "viewDidLoad"}
        elif tool_name == "xrefs":
            return ["0x1040f4100", "0x1040f4110"]
        elif tool_name == "list_strings":
            return [{"address": "0x100020000", "value": "Hello World"}]
        elif tool_name == "set_comment":
            return "OK"
        elif tool_name == "set_address_name":
            return "OK"
        else:
            return {"result": "ok"}

    @property
    def server_info(self):
        return self._server_info


@pytest.fixture
def mock_client():
    return MockHopperClient()


@pytest.fixture
def server_module(mock_client):
    with patch("HopperProxyMCP.hopper_client.HopperMCPSubprocessClient") as mock_class:
        mock_instance = MagicMock()
        mock_instance.start.return_value = {"name": "HopperMCPServer", "version": "0.1.0"}
        mock_instance.stop.return_value = None
        mock_instance.call_tool.side_effect = mock_client.call_tool
        mock_class.return_value = mock_instance

        from fastmcp import Client
        import importlib
        import HopperProxyMCP.server as server_mod
        importlib.reload(server_mod)
        yield server_mod


class TestProxyTools:
    @pytest.mark.asyncio
    async def test_binary_overview(self, server_module, mock_client):
        from fastmcp import Client
        async with Client(server_module.mcp) as client:
            result = await client.call_tool("binary_overview", {})
            assert "test_binary" in result.data
            assert "__TEXT" in result.data

    @pytest.mark.asyncio
    async def test_swift_classes(self, server_module, mock_client):
        from fastmcp import Client
        async with Client(server_module.mcp) as client:
            result = await client.call_tool("swift_classes", {"pattern": ""})
            data = json.loads(result.data)
            assert data["count"] >= 1
            assert any("_TtC" in c["name"] for c in data["classes"])

    @pytest.mark.asyncio
    async def test_get_objc_classes(self, server_module, mock_client):
        from fastmcp import Client
        async with Client(server_module.mcp) as client:
            result = await client.call_tool("get_objc_classes", {"pattern": ""})
            data = json.loads(result.data)
            assert data["count"] >= 1

    @pytest.mark.asyncio
    async def test_get_objc_protocols(self, server_module, mock_client):
        from fastmcp import Client
        async with Client(server_module.mcp) as client:
            result = await client.call_tool("get_objc_protocols", {})
            data = json.loads(result.data)
            assert "count" in data

    @pytest.mark.asyncio
    async def test_batch_decompile(self, server_module, mock_client):
        from fastmcp import Client
        async with Client(server_module.mcp) as client:
            result = await client.call_tool("batch_decompile", {
                "addresses": ["0x1040f4124", "0x1040f4150"]
            })
            data = json.loads(result.data)
            assert "0x1040f4124" in data

    @pytest.mark.asyncio
    async def test_get_call_graph_forward(self, server_module, mock_client):
        from fastmcp import Client
        async with Client(server_module.mcp) as client:
            result = await client.call_tool("get_call_graph", {
                "address": "0x1040f4124",
                "direction": "forward",
                "depth": 2
            })
            data = json.loads(result.data)
            assert "0" in data or 0 in data

    @pytest.mark.asyncio
    async def test_get_call_graph_backward(self, server_module, mock_client):
        from fastmcp import Client
        async with Client(server_module.mcp) as client:
            result = await client.call_tool("get_call_graph", {
                "address": "0x1040f4124",
                "direction": "backward",
                "depth": 2
            })
            data = json.loads(result.data)
            assert "0" in data or 0 in data

    @pytest.mark.asyncio
    async def test_analyze_swift_types(self, server_module, mock_client):
        from fastmcp import Client
        async with Client(server_module.mcp) as client:
            result = await client.call_tool("analyze_swift_types", {})
            data = json.loads(result.data)
            assert "total" in data
            assert "categories" in data

    @pytest.mark.asyncio
    async def test_find_xrefs_to_name(self, server_module, mock_client):
        from fastmcp import Client
        async with Client(server_module.mcp) as client:
            result = await client.call_tool("find_xrefs_to_name", {
                "name": "viewDidLoad"
            })
            data = json.loads(result.data)


class TestOfficialToolProxying:
    @pytest.mark.asyncio
    async def test_list_documents(self, server_module, mock_client):
        from fastmcp import Client
        async with Client(server_module.mcp) as client:
            result = await client.call_tool("list_documents", {})
            assert "test_binary" in result.data

    @pytest.mark.asyncio
    async def test_list_segments(self, server_module, mock_client):
        from fastmcp import Client
        async with Client(server_module.mcp) as client:
            result = await client.call_tool("list_segments", {})
            assert "__TEXT" in result.data

    @pytest.mark.asyncio
    async def test_list_procedures(self, server_module, mock_client):
        from fastmcp import Client
        async with Client(server_module.mcp) as client:
            result = await client.call_tool("list_procedures", {})
            assert "_TtC" in result.data

    @pytest.mark.asyncio
    async def test_procedure_pseudo_code(self, server_module, mock_client):
        from fastmcp import Client
        async with Client(server_module.mcp) as client:
            result = await client.call_tool("procedure_pseudo_code", {
                "procedure": "0x1040f4124"
            })
            assert "viewDidLoad" in result.data

    @pytest.mark.asyncio
    async def test_search_procedures(self, server_module, mock_client):
        from fastmcp import Client
        async with Client(server_module.mcp) as client:
            result = await client.call_tool("search_procedures", {
                "pattern": "viewDidLoad",
                "case_sensitive": False
            })
            assert "viewDidLoad" in result.data

    @pytest.mark.asyncio
    async def test_procedure_callees(self, server_module, mock_client):
        from fastmcp import Client
        async with Client(server_module.mcp) as client:
            result = await client.call_tool("procedure_callees", {
                "procedure": "0x1040f4124"
            })
            assert "0x1040f4160" in result.data or "0x1040f4170" in result.data

    @pytest.mark.asyncio
    async def test_procedure_callers(self, server_module, mock_client):
        from fastmcp import Client
        async with Client(server_module.mcp) as client:
            result = await client.call_tool("procedure_callers", {
                "procedure": "0x1040f4124"
            })
            assert "0x1040f4100" in result.data

    @pytest.mark.asyncio
    async def test_list_names(self, server_module, mock_client):
        from fastmcp import Client
        async with Client(server_module.mcp) as client:
            result = await client.call_tool("list_names", {})
            assert "_OBJC_CLASS_" in result.data or "_TtC" in result.data

    @pytest.mark.asyncio
    async def test_address_name(self, server_module, mock_client):
        from fastmcp import Client
        async with Client(server_module.mcp) as client:
            result = await client.call_tool("address_name", {
                "address": "0x1040f4124"
            })
            assert "viewDidLoad" in result.data

    @pytest.mark.asyncio
    async def test_xrefs(self, server_module, mock_client):
        from fastmcp import Client
        async with Client(server_module.mcp) as client:
            result = await client.call_tool("xrefs", {
                "address": "0x1040f4124"
            })
            assert "0x1040f4100" in result.data

    @pytest.mark.asyncio
    async def test_set_comment(self, server_module, mock_client):
        from fastmcp import Client
        async with Client(server_module.mcp) as client:
            result = await client.call_tool("set_comment", {
                "address": "0x1040f4124",
                "comment": "Test comment",
                "document": "test_binary"
            })
            assert result.data in ["OK", '{"result": "ok"}']

    @pytest.mark.asyncio
    async def test_set_address_name(self, server_module, mock_client):
        from fastmcp import Client
        async with Client(server_module.mcp) as client:
            result = await client.call_tool("set_address_name", {
                "address": "0x1040f4124",
                "name": "myFunction",
                "document": "test_binary"
            })
            assert result.data in ["OK", '{"result": "ok"}']


class TestMockClient:
    def test_call_history(self, mock_client):
        mock_client.call_tool("list_documents")
        mock_client.call_tool("list_segments")
        assert len(mock_client._call_history) == 2
        assert mock_client._call_history[0]["tool"] == "list_documents"
        assert mock_client._call_history[1]["tool"] == "list_segments"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
