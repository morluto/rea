import { describe, expect, it } from "vitest";
import { environmentManifestCaptureFixture } from "../../../tests/fixtures/analysisView.js";
import type { WebNetworkCaptureRecord } from "../webNetworkCapture.js";
import { EnvironmentManifestAccumulator } from "./EnvironmentManifestAccumulator.js";
import { EnvironmentStateAccumulator } from "./EnvironmentStateAccumulator.js";

const sample = (
  ordinal: number,
  path: string,
  postText?: string,
): WebNetworkCaptureRecord => ({
  ...environmentManifestCaptureFixture().records[0]!,
  ordinal,
  limitations: [],
  reported: {
    request: {
      method: postText === undefined ? "GET" : "POST",
      url: `https://manifest.test${path}`,
      ...(postText === undefined
        ? {}
        : { postData: { mimeType: "application/json", text: postText } }),
    },
    response: { status: 200, content: { mimeType: "application/json" } },
  },
});

const finished = (accumulator: EnvironmentManifestAccumulator) => {
  const result = accumulator.finish();
  if (!result.ok) throw result.error;
  return result.value;
};

it("refuses a body parse that exceeds the budget without retaining a partial tool", () => {
  const accumulator = new EnvironmentManifestAccumulator(32 * 1024);
  expect(accumulator.add(sample(0, "/api/items")).ok).toBe(true);
  const before = finished(accumulator);
  const body = `{"name":"${"x".repeat(2_000)}"}`;
  expect(accumulator.add(sample(1, "/api/items", body))).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError", resource: "memory" },
  });
  expect(finished(accumulator)).toEqual(before);
  expect(accumulator.add(sample(2, "/api/items", '{"name":"n"}')).ok).toBe(
    true,
  );
  expect(finished(accumulator).tools.map((tool) => tool.body_shape)).toEqual([
    null,
    { type: "object", properties: { name: "string" } },
  ]);
});

it("charges every retained record pointer so many records exhaust a small budget", () => {
  const accumulator = new EnvironmentManifestAccumulator(64 * 1024);
  let accepted = 0;
  for (; accepted < 1000; accepted += 1) {
    const result = accumulator.add(
      sample(accepted, `/api/route${String(accepted)}`),
    );
    if (result.ok) continue;
    expect(result.error).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
    });
    break;
  }
  expect(accepted).toBeGreaterThan(0);
  expect(accepted).toBeLessThan(1000);
  const manifest = finished(accumulator);
  expect(manifest.records).toHaveLength(accepted);
  expect(manifest.tools).toHaveLength(accepted);
  expect(manifest.coverage.total).toBe(accepted);
});

it("retains repeated observed values, statuses and query names once across many samples", () => {
  const accumulator = new EnvironmentManifestAccumulator(1024 * 1024);
  for (let ordinal = 0; ordinal < 1000; ordinal += 1)
    expect(
      accumulator.add(sample(ordinal, "/api/items/7?page=1&page=2")).ok,
    ).toBe(true);
  const manifest = finished(accumulator);
  expect(manifest.tools).toHaveLength(1);
  expect(manifest.tools[0]).toMatchObject({
    params: [{ observed_values: ["7"] }],
    query_parameter_names: ["page"],
    statuses: [200],
  });
  expect(manifest.tools[0]?.record_ordinals).toHaveLength(1000);
  expect(manifest.records).toHaveLength(1000);
});

it("charges every literal route part so a path of many short segments fails closed", () => {
  const accumulator = new EnvironmentManifestAccumulator(1024 * 1024);
  expect(accumulator.add(sample(0, "/a".repeat(100))).ok).toBe(true);
  expect(accumulator.add(sample(1, "/a".repeat(5_000)))).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError", resource: "memory" },
  });
  expect(finished(accumulator).tools).toHaveLength(1);
});

it("charges a request media type before scanning it so an oversized one fails closed", () => {
  const accumulator = new EnvironmentManifestAccumulator(64 * 1024);
  const record = sample(0, "/api/items", "{}");
  (
    record.reported as { request: { postData: { mimeType: string } } }
  ).request.postData.mimeType = `application/json${"x".repeat(100_000)}`;
  expect(accumulator.add(record)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError", resource: "memory" },
  });
  expect(finished(accumulator).tools).toHaveLength(0);
});

it("charges the group key before building it so an oversized request method fails closed", () => {
  const accumulator = new EnvironmentManifestAccumulator(64 * 1024);
  const record = sample(0, "/api/items");
  (record.reported as { request: { method: string } }).request.method =
    `GET${"X".repeat(100_000)}`;
  expect(accumulator.add(record)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError", resource: "memory" },
  });
  expect(finished(accumulator).tools).toHaveLength(0);
});

interface RpcExchangeSpec {
  readonly ordinal: number;
  readonly path: string;
  readonly requestMime?: string;
  readonly postText?: string;
  readonly responseMime?: string;
  readonly responseText?: string;
}

const rpcRecord = (spec: RpcExchangeSpec): WebNetworkCaptureRecord => ({
  ...environmentManifestCaptureFixture().records[0]!,
  ordinal: spec.ordinal,
  limitations: [],
  reported: {
    startedDateTime: new Date(
      1_700_000_000_000 + spec.ordinal * 100,
    ).toISOString(),
    time: 10,
    request: {
      method: "POST",
      url: `https://manifest.test${spec.path}`,
      ...(spec.postText === undefined
        ? {}
        : {
            postData: {
              mimeType: spec.requestMime ?? "application/json",
              text: spec.postText,
            },
          }),
    },
    response: {
      status: 200,
      content: {
        mimeType: spec.responseMime ?? "application/json",
        ...(spec.responseText === undefined ? {} : { text: spec.responseText }),
      },
    },
  },
});

const multiplexedManifestRecords = (): readonly WebNetworkCaptureRecord[] => [
  rpcRecord({
    ordinal: 0,
    path: "/api/orgs/org-1/graphql",
    postText: JSON.stringify({
      operationName: "GetViewer",
      query: "query GetViewer { viewer { id } }",
    }),
  }),
  rpcRecord({
    ordinal: 1,
    path: "/api/orgs/org-2/graphql",
    postText: JSON.stringify({
      operationName: "GetViewer",
      query: "query GetViewer { viewer { id } }",
    }),
  }),
  rpcRecord({
    ordinal: 2,
    path: "/api/orgs/org-1/graphql",
    postText: JSON.stringify({
      operationName: "UpdateProfile",
      query:
        "mutation UpdateProfile($name: String!) { updateProfile(name: $name) { id } }",
      variables: { name: "Ada" },
    }),
  }),
  rpcRecord({
    ordinal: 3,
    path: "/api/orgs/org-1/graphql",
    postText: JSON.stringify({ query: "{ __typename }" }),
  }),
  rpcRecord({
    ordinal: 4,
    path: "/rpc",
    postText: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/list",
      id: 1,
    }),
  }),
  rpcRecord({
    ordinal: 5,
    path: "/rpc",
    postText: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      id: 2,
    }),
  }),
  rpcRecord({
    ordinal: 6,
    path: "/_/AppUi/data/batchexecute?rpcids=GetItems",
    requestMime: "application/x-www-form-urlencoded;charset=UTF-8",
    postText: new URLSearchParams({
      "f.req": JSON.stringify([[["GetItems", "[]", null, "generic"]]]),
    }).toString(),
    responseMime: "application/x-javascript; charset=utf-8",
    responseText:
      ')]}\'\n[[["wrb.fr","GetItems","[{\\"id\\":1}]",null,null,null,"generic"]]]',
  }),
  rpcRecord({
    ordinal: 7,
    path: "/_/AppUi/data/batchexecute?rpcids=SaveItem",
    requestMime: "application/x-www-form-urlencoded;charset=UTF-8",
    postText: new URLSearchParams({
      "f.req": JSON.stringify([[["SaveItem", '[{"id":1}]', null, "generic"]]]),
    }).toString(),
    responseMime: "text/plain; charset=utf-8",
    responseText:
      ')]}\'\n[[["wrb.fr","SaveItem","{\\"ok\\":true}",null,null,null,"generic"]]]',
  }),
  rpcRecord({
    ordinal: 8,
    path: "/api/items",
    postText: JSON.stringify({ name: "plain-rest" }),
  }),
  rpcRecord({
    ordinal: 9,
    path: "/api/orgs/org-1/graphql",
    postText: JSON.stringify({
      operationName: "ListMembers",
      query: "query ListMembers { members { id } }",
    }),
  }),
  rpcRecord({
    ordinal: 10,
    path: "/api/orgs/org-2/graphql",
    postText: JSON.stringify({
      operationName: "ListMembers",
      query: "query ListMembers { members { id } }",
    }),
  }),
];

describe("multiplexed POST RPC manifest grouping", () => {
  it("splits GraphQL, JSON-RPC 2.0, and batchexecute operations into distinct manifest tools and preserves template rules", () => {
    const accumulator = new EnvironmentManifestAccumulator(1024 * 1024, true, [
      "sibling-variance",
    ]);
    for (const record of multiplexedManifestRecords()) {
      expect(accumulator.add(record).ok).toBe(true);
    }
    const manifest = finished(accumulator);
    expect(manifest.excluded).toEqual([]);
    expect(
      manifest.tools.map((tool) => ({
        name: tool.name,
        path_template: tool.path_template,
        rpc_operation: tool.rpc_operation,
        record_ordinals: tool.record_ordinals,
      })),
    ).toEqual([
      {
        name: "post_appui_data_batchexecute_get_items",
        path_template: "/_/AppUi/data/batchexecute",
        rpc_operation: { kind: "batchexecute", name: "GetItems" },
        record_ordinals: [6],
      },
      {
        name: "post_appui_data_batchexecute_save_item",
        path_template: "/_/AppUi/data/batchexecute",
        rpc_operation: { kind: "batchexecute", name: "SaveItem" },
        record_ordinals: [7],
      },
      {
        name: "post_items",
        path_template: "/api/items",
        rpc_operation: undefined,
        record_ordinals: [8],
      },
      {
        name: "post_orgs_org_1_graphql",
        path_template: "/api/orgs/org-1/graphql",
        rpc_operation: undefined,
        record_ordinals: [3],
      },
      {
        name: "post_orgs_org_1_graphql_update_profile",
        path_template: "/api/orgs/org-1/graphql",
        rpc_operation: { kind: "graphql", name: "UpdateProfile" },
        record_ordinals: [2],
      },
      {
        name: "post_orgs_graphql_get_viewer_by_org_id",
        path_template: "/api/orgs/{org_id}/graphql",
        rpc_operation: { kind: "graphql", name: "GetViewer" },
        record_ordinals: [0, 1],
      },
      {
        name: "post_orgs_graphql_list_members_by_org_id",
        path_template: "/api/orgs/{org_id}/graphql",
        rpc_operation: { kind: "graphql", name: "ListMembers" },
        record_ordinals: [9, 10],
      },
      {
        name: "post_rpc_tools_call",
        path_template: "/rpc",
        rpc_operation: { kind: "json-rpc", name: "tools/call" },
        record_ordinals: [5],
      },
      {
        name: "post_rpc_tools_list",
        path_template: "/rpc",
        rpc_operation: { kind: "json-rpc", name: "tools/list" },
        record_ordinals: [4],
      },
    ]);
  });
});

describe("multiplexed POST RPC state partitioning", () => {
  it("partitions read and write RPC operations into separate state buckets in EnvironmentStateAccumulator", () => {
    const stateAccumulator = new EnvironmentStateAccumulator(1024 * 1024);
    const sharedDocument = [
      "query GetViewer { viewer { id name } }",
      "mutation UpdateProfile($name: String!) { updateProfile(name: $name) { id name } }",
    ].join("\n");
    const records: readonly WebNetworkCaptureRecord[] = [
      rpcRecord({
        ordinal: 0,
        path: "/graphql",
        postText: JSON.stringify({
          operationName: "GetViewer",
          query: sharedDocument,
        }),
        responseText: JSON.stringify({
          data: { viewer: { id: "u1", name: "Ada" } },
        }),
      }),
      rpcRecord({
        ordinal: 1,
        path: "/graphql",
        postText: JSON.stringify({
          operationName: "UpdateProfile",
          query: sharedDocument,
          variables: { name: "Grace" },
        }),
        responseText: JSON.stringify({
          data: { updateProfile: { id: "u1", name: "Grace" } },
        }),
      }),
      rpcRecord({
        ordinal: 2,
        path: "/rpc",
        postText: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/list",
          id: 1,
        }),
        responseText: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { tools: [] },
        }),
      }),
      rpcRecord({
        ordinal: 3,
        path: "/rpc",
        postText: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          id: 2,
        }),
        responseText: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: { ok: true },
        }),
      }),
      rpcRecord({
        ordinal: 4,
        path: "/_/AppUi/data/batchexecute?rpcids=GetItems",
        requestMime: "application/x-www-form-urlencoded",
        postText: new URLSearchParams({
          "f.req": JSON.stringify([[["GetItems", "[]", null, "generic"]]]),
        }).toString(),
        responseMime: "application/x-javascript",
        responseText:
          ')]}\'\n[[["wrb.fr","GetItems","[1,2]",null,null,null,"generic"]]]',
      }),
    ];
    for (const record of records)
      expect(stateAccumulator.add(record).ok).toBe(true);
    const state = stateAccumulator.finishState();
    if (!state.ok) throw state.error;
    expect(state.value.views).toEqual([
      {
        tool: "post_appui_data_batchexecute",
        shape: "recorded",
        reason: "query-body",
      },
      {
        tool: "post_graphql_get_viewer",
        shape: "recorded",
        reason: "query-body",
      },
      {
        tool: "post_rpc_tools_list",
        shape: "recorded",
        reason: "query-body",
      },
    ]);
    expect(state.value.writes.map((plan) => plan.tool)).toEqual([
      "post_graphql_update_profile",
      "post_rpc_tools_call",
    ]);
  });
});

describe("single-operation POST RPC paths", () => {
  it("preserves plain tool names without rpc_operation when one operation occupies a POST path while still classifying read-only RPCs", () => {
    const readAccumulator = new EnvironmentStateAccumulator(1024 * 1024);
    const readRecords: readonly WebNetworkCaptureRecord[] = [
      rpcRecord({
        ordinal: 0,
        path: "/graphql",
        postText: JSON.stringify({
          operationName: "GetViewer",
          query: "query GetViewer { viewer { id } }",
        }),
        responseText: JSON.stringify({ data: { viewer: { id: "u1" } } }),
      }),
      rpcRecord({
        ordinal: 1,
        path: "/rpc",
        postText: JSON.stringify({
          jsonrpc: "2.0",
          method: "users.get",
          id: 1,
        }),
        responseText: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { id: "u1" },
        }),
      }),
      rpcRecord({
        ordinal: 2,
        path: "/_/AppUi/data/batchexecute?rpcids=GetItems",
        requestMime: "application/x-www-form-urlencoded",
        postText: new URLSearchParams({
          "f.req": JSON.stringify([[["GetItems", "[]", null, "generic"]]]),
        }).toString(),
        responseMime: "text/plain",
        responseText:
          ')]}\'\n[[["wrb.fr","GetItems","[1]",null,null,null,"generic"]]]',
      }),
    ];
    for (const record of readRecords)
      expect(readAccumulator.add(record).ok).toBe(true);
    const manifest = finished(readAccumulator);
    expect(
      manifest.tools.map((tool) => ({
        name: tool.name,
        rpc_operation: tool.rpc_operation,
      })),
    ).toEqual([
      { name: "post_appui_data_batchexecute", rpc_operation: undefined },
      { name: "post_graphql", rpc_operation: undefined },
      { name: "post_rpc", rpc_operation: undefined },
    ]);
    const readState = readAccumulator.finishState();
    if (!readState.ok) throw readState.error;
    expect(readState.value.views.map((view) => view.tool)).toEqual([
      "post_appui_data_batchexecute",
      "post_graphql",
      "post_rpc",
    ]);
    expect(readState.value.writes).toEqual([]);

    const writeAccumulator = new EnvironmentStateAccumulator(1024 * 1024);
    expect(
      writeAccumulator.add(
        rpcRecord({
          ordinal: 0,
          path: "/graphql",
          postText: JSON.stringify({
            operationName: "UpdateViewer",
            query: "mutation UpdateViewer { updateViewer { id } }",
          }),
        }),
      ).ok,
    ).toBe(true);
    expect(finished(writeAccumulator).tools.map((tool) => tool.name)).toEqual([
      "post_graphql",
    ]);
    const writeState = writeAccumulator.finishState();
    if (!writeState.ok) throw writeState.error;
    expect(writeState.value.views).toEqual([]);
    expect(writeState.value.writes.map((plan) => plan.tool)).toEqual([
      "post_graphql",
    ]);
  });
});

describe("multiplexed batchexecute query-parameter projection", () => {
  it("keeps query-only batchexecute operations separate when include_query_parameter_names is false", () => {
    const records: readonly WebNetworkCaptureRecord[] = [
      rpcRecord({
        ordinal: 0,
        path: "/_/AppUi/data/batchexecute?rpcids=GetItems&source-path=%2F",
        requestMime: "application/x-www-form-urlencoded",
        postText: "at=csrf-token",
        responseMime: "text/plain",
        responseText:
          ')]}\'\n[[["wrb.fr","GetItems","[1]",null,null,null,"generic"]]]',
      }),
      rpcRecord({
        ordinal: 1,
        path: "/_/AppUi/data/batchexecute?rpcids=SaveItem&source-path=%2F",
        requestMime: "application/x-www-form-urlencoded",
        postText: "at=csrf-token",
        responseMime: "text/plain",
        responseText:
          ')]}\'\n[[["wrb.fr","SaveItem","{\\"ok\\":true}",null,null,null,"generic"]]]',
      }),
    ];
    const manifestWithoutQueryNames = new EnvironmentManifestAccumulator(
      1024 * 1024,
      false,
    );
    const stateAccumulator = new EnvironmentStateAccumulator(1024 * 1024);
    for (const record of records) {
      expect(manifestWithoutQueryNames.add(record).ok).toBe(true);
      expect(stateAccumulator.add(record).ok).toBe(true);
    }
    const manifest = finished(manifestWithoutQueryNames);
    const state = stateAccumulator.finishState();
    if (!state.ok) throw state.error;
    expect(
      manifest.tools.map((tool) => ({
        name: tool.name,
        rpc_operation: tool.rpc_operation,
        query_parameter_names: tool.query_parameter_names,
      })),
    ).toEqual([
      {
        name: "post_appui_data_batchexecute_get_items",
        rpc_operation: { kind: "batchexecute", name: "GetItems" },
        query_parameter_names: [],
      },
      {
        name: "post_appui_data_batchexecute_save_item",
        rpc_operation: { kind: "batchexecute", name: "SaveItem" },
        query_parameter_names: [],
      },
    ]);
    expect(state.value.views.map((view) => view.tool)).toEqual([
      "post_appui_data_batchexecute_get_items",
    ]);
    expect(state.value.writes.map((plan) => plan.tool)).toEqual([
      "post_appui_data_batchexecute_save_item",
    ]);
  });
});

describe("overlapping POST RPC route templates", () => {
  it("retains rpc_operation when a literal POST RPC route overlaps a templated POST RPC route", () => {
    const accumulator = new EnvironmentManifestAccumulator(1024 * 1024, true, [
      "sibling-variance",
    ]);
    const records: readonly WebNetworkCaptureRecord[] = [
      rpcRecord({
        ordinal: 0,
        path: "/api/orgs/org-1/graphql",
        postText: JSON.stringify({
          operationName: "UpdateProfile",
          query: "mutation UpdateProfile { updateProfile { id } }",
        }),
      }),
      rpcRecord({
        ordinal: 1,
        path: "/api/orgs/org-1/graphql",
        postText: JSON.stringify({
          operationName: "GetViewer",
          query: "query GetViewer { viewer { id } }",
        }),
      }),
      rpcRecord({
        ordinal: 2,
        path: "/api/orgs/org-2/graphql",
        postText: JSON.stringify({
          operationName: "GetViewer",
          query: "query GetViewer { viewer { id } }",
        }),
      }),
      rpcRecord({
        ordinal: 3,
        path: "/api/status/graphql",
        postText: JSON.stringify({
          operationName: "GetHealth",
          query: "query GetHealth { ok }",
        }),
      }),
    ];
    for (const record of records) expect(accumulator.add(record).ok).toBe(true);
    const manifest = finished(accumulator);
    expect(
      manifest.tools.map((tool) => ({
        name: tool.name,
        path_template: tool.path_template,
        rpc_operation: tool.rpc_operation,
      })),
    ).toEqual([
      {
        name: "post_orgs_org_1_graphql_update_profile",
        path_template: "/api/orgs/org-1/graphql",
        rpc_operation: { kind: "graphql", name: "UpdateProfile" },
      },
      {
        name: "post_orgs_graphql_get_viewer_by_org_id",
        path_template: "/api/orgs/{org_id}/graphql",
        rpc_operation: { kind: "graphql", name: "GetViewer" },
      },
      {
        name: "post_status_graphql",
        path_template: "/api/status/graphql",
        rpc_operation: undefined,
      },
    ]);
  });
});

describe("indexed route overlap scaling for large literal POST batches", () => {
  it("indexes 1500 distinct literal POST RPC routes without quadratic scans while splitting overlapping pairs and wildcards", () => {
    const accumulator = new EnvironmentManifestAccumulator(16 * 1024 * 1024);
    let ordinal = 0;
    for (let index = 0; index < 1500; index += 1) {
      expect(
        accumulator.add(
          rpcRecord({
            ordinal,
            path: `/api/orgs/org-${String(index)}/graphql`,
            postText: JSON.stringify({
              operationName: `GetOrg${String(index)}`,
              query: `query GetOrg${String(index)} { id }`,
            }),
          }),
        ).ok,
      ).toBe(true);
      ordinal += 1;
    }
    for (const op of ["GetShared", "UpdateShared"] as const) {
      expect(
        accumulator.add(
          rpcRecord({
            ordinal,
            path: "/api/orgs/shared/graphql",
            postText: JSON.stringify({
              operationName: op,
              query: `query ${op} { ok }`,
            }),
          }),
        ).ok,
      ).toBe(true);
      ordinal += 1;
    }
    expect(
      accumulator.add(
        rpcRecord({
          ordinal,
          path: "/api/teams/7/graphql",
          postText: JSON.stringify({
            operationName: "GetTeamNumeric",
            query: "query GetTeamNumeric { id }",
          }),
        }),
      ).ok,
    ).toBe(true);
    ordinal += 1;
    expect(
      accumulator.add(
        rpcRecord({
          ordinal,
          path: "/api/teams/%34%32/graphql",
          postText: JSON.stringify({
            operationName: "GetTeamEncoded",
            query: "query GetTeamEncoded { id }",
          }),
        }),
      ).ok,
    ).toBe(true);
    ordinal += 1;
    expect(
      accumulator.add(
        rpcRecord({
          ordinal,
          path: "/api/teams/search/graphql",
          postText: JSON.stringify({
            operationName: "SearchTeams",
            query: "query SearchTeams { id }",
          }),
        }),
      ).ok,
    ).toBe(true);

    const start = performance.now();
    const manifest = finished(accumulator);
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(1000);
    expect(manifest.tools).toHaveLength(1505);
    const discriminated = manifest.tools
      .filter((tool) => tool.rpc_operation !== undefined)
      .map((tool) => ({
        path_template: tool.path_template,
        rpc_operation: tool.rpc_operation,
      }));
    expect(discriminated).toEqual([
      {
        path_template: "/api/orgs/shared/graphql",
        rpc_operation: { kind: "graphql", name: "GetShared" },
      },
      {
        path_template: "/api/orgs/shared/graphql",
        rpc_operation: { kind: "graphql", name: "UpdateShared" },
      },
      {
        path_template: "/api/teams/%34%32/graphql",
        rpc_operation: { kind: "graphql", name: "GetTeamEncoded" },
      },
      {
        path_template: "/api/teams/{numeric}/graphql",
        rpc_operation: { kind: "graphql", name: "GetTeamNumeric" },
      },
    ]);
  });
});

describe("percent-encoded literal route overlap parity", () => {
  it("matches once-decoded literal segments without conflating twice-encoded or case-distinct encodings", () => {
    const buildTools = (
      entries: readonly (readonly [string, string])[],
    ): readonly {
      readonly path_template: string;
      readonly rpc_operation?: { readonly kind: string; readonly name: string };
    }[] => {
      const accumulator = new EnvironmentManifestAccumulator(1024 * 1024);
      for (const [ordinal, [path, op]] of entries.entries())
        expect(
          accumulator.add(
            rpcRecord({
              ordinal,
              path,
              postText: JSON.stringify({
                operationName: op,
                query: `query ${op} { ok }`,
              }),
            }),
          ).ok,
        ).toBe(true);
      return finished(accumulator).tools.map((tool) => ({
        path_template: tool.path_template,
        ...(tool.rpc_operation === undefined
          ? {}
          : { rpc_operation: tool.rpc_operation }),
      }));
    };

    expect(
      buildTools([
        ["/api/books/book%31/graphql", "GetEncoded"],
        ["/api/books/book1/graphql", "GetPlain"],
        ["/api/books/other/graphql", "GetOther"],
      ]),
    ).toEqual([
      {
        path_template: "/api/books/book%31/graphql",
        rpc_operation: { kind: "graphql", name: "GetEncoded" },
      },
      {
        path_template: "/api/books/book1/graphql",
        rpc_operation: { kind: "graphql", name: "GetPlain" },
      },
      { path_template: "/api/books/other/graphql" },
    ]);

    expect(
      buildTools([
        ["/api/books/book%2531/graphql", "GetTwice"],
        ["/api/books/book1/graphql", "GetPlain"],
        ["/api/books/other/graphql", "GetOther"],
      ]),
    ).toEqual([
      { path_template: "/api/books/book%2531/graphql" },
      { path_template: "/api/books/book1/graphql" },
      { path_template: "/api/books/other/graphql" },
    ]);

    expect(
      buildTools([
        ["/api/tags/a%2db/graphql", "GetLowerHex"],
        ["/api/tags/a%2Db/graphql", "GetUpperHex"],
        ["/api/tags/other/graphql", "GetOther"],
      ]),
    ).toEqual([
      { path_template: "/api/tags/a%2Db/graphql" },
      { path_template: "/api/tags/a%2db/graphql" },
      { path_template: "/api/tags/other/graphql" },
    ]);

    expect(
      buildTools([
        ["/api/tags/a%2db/graphql", "GetLowerHex"],
        ["/api/tags/a%2Db/graphql", "GetUpperHex"],
        ["/api/tags/a-b/graphql", "GetDecoded"],
        ["/api/tags/other/graphql", "GetOther"],
      ]),
    ).toEqual([
      {
        path_template: "/api/tags/a%2Db/graphql",
        rpc_operation: { kind: "graphql", name: "GetUpperHex" },
      },
      {
        path_template: "/api/tags/a%2db/graphql",
        rpc_operation: { kind: "graphql", name: "GetLowerHex" },
      },
      {
        path_template: "/api/tags/a-b/graphql",
        rpc_operation: { kind: "graphql", name: "GetDecoded" },
      },
      { path_template: "/api/tags/other/graphql" },
    ]);
  });
});

describe("deeply nested POST RPC route overlap without stack overflow", () => {
  it("extracts manifest and state for 3500-segment parameterized GraphQL routes iteratively", () => {
    const deepPath = `/api${"/a".repeat(3500)}/7/graphql`;
    const distinctDeepPath = `/api/isolated${"/a".repeat(3499)}/7/graphql`;
    const accumulator = new EnvironmentStateAccumulator();
    const ops = ["GetFirst", "GetSecond", "GetThird"] as const;
    for (const [ordinal, op] of ops.entries())
      expect(
        accumulator.add(
          rpcRecord({
            ordinal,
            path: deepPath,
            postText: JSON.stringify({
              operationName: op,
              query: `query ${op} { viewer { id } }`,
            }),
            responseText: JSON.stringify({
              data: { viewer: { id: `u-${String(ordinal)}` } },
            }),
          }),
        ).ok,
      ).toBe(true);
    expect(
      accumulator.add(
        rpcRecord({
          ordinal: 3,
          path: distinctDeepPath,
          postText: JSON.stringify({
            operationName: "GetIsolated",
            query: "query GetIsolated { ok }",
          }),
          responseText: JSON.stringify({ data: { ok: true } }),
        }),
      ).ok,
    ).toBe(true);

    const manifest = finished(accumulator);
    expect(manifest.tools).toHaveLength(4);
    expect(
      manifest.tools.map((tool) => tool.rpc_operation?.name ?? "single"),
    ).toEqual(["GetFirst", "GetSecond", "GetThird", "single"]);

    const state = accumulator.finishState();
    if (!state.ok) throw state.error;
    expect(state.value.views).toHaveLength(4);
    expect(
      state.value.views.every(
        (view) => view.shape === "recorded" && view.reason === "query-body",
      ),
    ).toBe(true);
  });
});
