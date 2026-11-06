import { describe, expect, it } from "vitest";

import {
  hasXssiGuardPrefix,
  isXssiEligibleMediaType,
  parseXssiOrExactJson,
  RPC_OPERATION_NAME_LIMIT,
  RPC_QUERY_LIMIT_CHARS,
  RPC_REQUEST_BODY_LIMIT_BYTES,
  selectRpcOperationFromText,
  selectRpcOperationFromValue,
} from "./rpcOperationSelector.js";

describe("selectRpcOperationFromText and selectRpcOperationFromValue", () => {
  it("discriminates GraphQL POST requests with a valid operationName", () => {
    expect(
      selectRpcOperationFromText({
        method: "POST",
        path: "/graphql",
        mimeType: "application/json; charset=utf-8",
        bodyText: JSON.stringify({
          operationName: "GetViewer",
          query: "query GetViewer { viewer { id } }",
        }),
      }),
    ).toEqual({ kind: "graphql", name: "GetViewer" });

    expect(
      selectRpcOperationFromValue({
        method: "POST",
        path: "/api/v1/query-gateway",
        body: {
          operationName: "_PersistedLookup_1",
          extensions: { persistedQuery: { version: 1, sha256Hash: "abc" } },
        },
      }),
    ).toEqual({ kind: "graphql", name: "_PersistedLookup_1" });
  });

  it("discriminates JSON-RPC 2.0 POST requests by method", () => {
    expect(
      selectRpcOperationFromText({
        method: "POST",
        path: "/mcp",
        mimeType: "application/json",
        bodyText: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/list",
          id: 1,
        }),
      }),
    ).toEqual({ kind: "json-rpc", name: "tools/list" });

    expect(
      selectRpcOperationFromValue({
        method: "POST",
        path: "/rpc",
        body: {
          jsonrpc: "2.0",
          method: "resources/templates/list",
          params: {},
        },
      }),
    ).toEqual({ kind: "json-rpc", name: "resources/templates/list" });
  });

  it("discriminates Google batchexecute POST requests from f.req or unambiguous rpcids", () => {
    const form = new URLSearchParams({
      "f.req": JSON.stringify([[["MaZiqc", '["item-1"]', null, "generic"]]]),
      at: "csrf-token",
    }).toString();
    expect(
      selectRpcOperationFromText({
        method: "POST",
        path: "/_/AppUi/data/batchexecute",
        query: "?rpcids=MaZiqc&source-path=%2F",
        mimeType: "application/x-www-form-urlencoded;charset=UTF-8",
        bodyText: form,
      }),
    ).toEqual({ kind: "batchexecute", name: "MaZiqc" });

    const repeatedSameId = new URLSearchParams({
      "f.req": JSON.stringify([
        [
          ["MaZiqc", "[1]", null, "1"],
          ["MaZiqc", "[2]", null, "2"],
        ],
      ]),
    }).toString();
    expect(
      selectRpcOperationFromValue({
        method: "POST",
        path: "/_/AppUi/data/batchexecute",
        body: repeatedSameId,
      }),
    ).toEqual({ kind: "batchexecute", name: "MaZiqc" });

    expect(
      selectRpcOperationFromValue({
        method: "POST",
        path: "/_/AppUi/data/batchexecute",
        query: "?rpcids=FEPhDc",
        body: undefined,
      }),
    ).toEqual({ kind: "batchexecute", name: "FEPhDc" });
  });
});

describe("selectRpcOperation fallback cases", () => {
  it("falls back to undefined for non-POST, ordinary REST, malformed JSON, missing operationName, and ambiguous batches", () => {
    expect(
      selectRpcOperationFromText({
        method: "GET",
        path: "/graphql",
        bodyText: '{"operationName":"GetViewer","query":"{ viewer { id } }"}',
      }),
    ).toBeUndefined();

    expect(
      selectRpcOperationFromText({
        method: "POST",
        path: "/api/items",
        mimeType: "application/json",
        bodyText: '{"name":"widget","operationName":"notGraphql"}',
      }),
    ).toBeUndefined();

    expect(
      selectRpcOperationFromText({
        method: "POST",
        path: "/graphql",
        mimeType: "application/json",
        bodyText: '{"query":"{ viewer { id } }"}',
      }),
    ).toBeUndefined();

    expect(
      selectRpcOperationFromText({
        method: "POST",
        path: "/graphql",
        mimeType: "application/json",
        bodyText: '{"operationName":"123Invalid","query":"{ id }"}',
      }),
    ).toBeUndefined();

    expect(
      selectRpcOperationFromText({
        method: "POST",
        path: "/graphql",
        mimeType: "application/json",
        bodyText: "{malformed",
      }),
    ).toBeUndefined();

    expect(
      selectRpcOperationFromText({
        method: "POST",
        path: "/rpc",
        mimeType: "application/json",
        bodyText: JSON.stringify([
          { jsonrpc: "2.0", method: "tools/list", id: 1 },
          { jsonrpc: "2.0", method: "tools/call", id: 2 },
        ]),
      }),
    ).toBeUndefined();

    expect(
      selectRpcOperationFromText({
        method: "POST",
        path: "/rpc",
        mimeType: "application/json",
        bodyText: JSON.stringify({ jsonrpc: "1.0", method: "legacy" }),
      }),
    ).toBeUndefined();

    const multiBatch = new URLSearchParams({
      "f.req": JSON.stringify([
        [
          ["MaZiqc", "[]", null, "1"],
          ["FEPhDc", "[]", null, "2"],
        ],
      ]),
    }).toString();
    expect(
      selectRpcOperationFromText({
        method: "POST",
        path: "/_/AppUi/data/batchexecute",
        query: "?rpcids=MaZiqc",
        mimeType: "application/x-www-form-urlencoded",
        bodyText: multiBatch,
      }),
    ).toBeUndefined();

    expect(
      selectRpcOperationFromText({
        method: "POST",
        path: "/_/AppUi/data/batchexecute",
        query: "?rpcids=MaZiqc,FEPhDc",
      }),
    ).toBeUndefined();
  });
});

describe("selectRpcOperation length and byte bounds", () => {
  it("enforces identifier length, body byte, and query length bounds", () => {
    const exactName = "A".repeat(RPC_OPERATION_NAME_LIMIT);
    const overName = "A".repeat(RPC_OPERATION_NAME_LIMIT + 1);
    expect(
      selectRpcOperationFromValue({
        method: "POST",
        path: "/graphql",
        body: { operationName: exactName, query: "{ ok }" },
      }),
    ).toEqual({ kind: "graphql", name: exactName });
    expect(
      selectRpcOperationFromValue({
        method: "POST",
        path: "/graphql",
        body: { operationName: overName, query: "{ ok }" },
      }),
    ).toBeUndefined();

    expect(
      selectRpcOperationFromValue({
        method: "POST",
        path: "/rpc",
        body: { jsonrpc: "2.0", method: exactName },
      }),
    ).toEqual({ kind: "json-rpc", name: exactName });
    expect(
      selectRpcOperationFromValue({
        method: "POST",
        path: "/rpc",
        body: { jsonrpc: "2.0", method: overName },
      }),
    ).toBeUndefined();

    const prefix = '{"jsonrpc":"2.0","method":"ping","pad":"';
    const suffix = '"}';
    const exactBody = `${prefix}${"x".repeat(RPC_REQUEST_BODY_LIMIT_BYTES - prefix.length - suffix.length)}${suffix}`;
    expect(Buffer.byteLength(exactBody, "utf8")).toBe(
      RPC_REQUEST_BODY_LIMIT_BYTES,
    );
    expect(
      selectRpcOperationFromText({
        method: "POST",
        path: "/rpc",
        mimeType: "application/json",
        bodyText: exactBody,
      }),
    ).toEqual({ kind: "json-rpc", name: "ping" });

    const overUtf8Body = `${prefix}${"é".repeat(Math.ceil(RPC_REQUEST_BODY_LIMIT_BYTES / 2))}${suffix}`;
    expect(overUtf8Body.length).toBeLessThan(RPC_REQUEST_BODY_LIMIT_BYTES);
    expect(Buffer.byteLength(overUtf8Body, "utf8")).toBeGreaterThan(
      RPC_REQUEST_BODY_LIMIT_BYTES,
    );
    expect(
      selectRpcOperationFromText({
        method: "POST",
        path: "/rpc",
        mimeType: "application/json",
        bodyText: overUtf8Body,
      }),
    ).toBeUndefined();

    const longQuery = `?rpcids=MaZiqc&pad=${"q".repeat(RPC_QUERY_LIMIT_CHARS)}`;
    expect(
      selectRpcOperationFromText({
        method: "POST",
        path: "/_/AppUi/data/batchexecute",
        query: longQuery,
      }),
    ).toBeUndefined();
  });
});

describe("XSSI response prefix detection and parsing", () => {
  it("recognizes eligible media types and strips leading XSSI prefixes", () => {
    expect(isXssiEligibleMediaType("application/json")).toBe(true);
    expect(isXssiEligibleMediaType("text/plain")).toBe(true);
    expect(isXssiEligibleMediaType("application/x-javascript")).toBe(true);
    expect(isXssiEligibleMediaType("text/html")).toBe(false);

    expect(hasXssiGuardPrefix(')]}\'\n{"ok":true}')).toBe(true);
    expect(hasXssiGuardPrefix(")]}',\r\n[1,2]")).toBe(true);
    expect(hasXssiGuardPrefix(")]}'without-newline")).toBe(false);

    expect(parseXssiOrExactJson(')]}\'\n{"viewer":{"id":7}}')).toEqual({
      viewer: { id: 7 },
    });

    const chunkOne = JSON.stringify([
      [["wrb.fr", "MaZiqc", '[{"id":"a"}]', null, null, null, "generic"]],
    ]);
    const chunkTwo = JSON.stringify([["di", 18]]);
    const framed = `)]}'\n\n${String(chunkOne.length + 1)}\n${chunkOne}\n${String(chunkTwo.length + 1)}\n${chunkTwo}\n`;
    expect(parseXssiOrExactJson(framed)).toEqual([
      [[["wrb.fr", "MaZiqc", '[{"id":"a"}]', null, null, null, "generic"]]],
      [["di", 18]],
    ]);
    expect(parseXssiOrExactJson(")]}'\nnot-json")).toBeUndefined();
  });
});
