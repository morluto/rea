import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { KubernetesAuditLogArtifactReader } from "./KubernetesAuditLogArtifactReader.js";
import {
  KUBERNETES_AUDIT_INLINE_DIAGNOSTIC_LIMIT,
  KUBERNETES_AUDIT_INLINE_EVENT_LIMIT,
  KUBERNETES_AUDIT_INLINE_VERB_LIMIT,
} from "../domain/linux/kubernetesAuditLog.js";
import { KUBERNETES_AUDIT_JSON_DEPTH } from "../domain/linux/kubernetesAuditRecord.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

interface EventOverrides {
  readonly auditID?: string;
  readonly stage?: string;
  readonly verb?: string;
  readonly requestURI?: string;
  readonly username?: string;
  readonly groups?: readonly string[];
  readonly sourceIPs?: readonly string[];
  readonly userAgent?: string;
  readonly resource?: string;
  readonly namespace?: string;
  readonly name?: string;
  readonly responseCode?: number;
  readonly responseBody?: unknown;
  readonly requestReceivedTimestamp?: string;
}

const auditEvent = (overrides: EventOverrides = {}): string =>
  JSON.stringify({
    kind: "Event",
    apiVersion: "audit.k8s.io/v1",
    auditID: overrides.auditID ?? "00000000-0000-4000-8000-000000000001",
    stage: overrides.stage ?? "RequestReceived",
    requestURI: overrides.requestURI ?? "/api/v1/namespaces/default/pods",
    verb: overrides.verb ?? "get",
    user: {
      username: overrides.username ?? "system:serviceaccount:default:reader",
      groups: overrides.groups ?? [
        "system:serviceaccounts",
        "system:authenticated",
      ],
    },
    sourceIPs: overrides.sourceIPs ?? ["10.0.0.7"],
    userAgent: overrides.userAgent ?? "kubectl/v1.30.0",
    objectRef: {
      resource: overrides.resource ?? "pods",
      namespace: overrides.namespace ?? "default",
      name: overrides.name ?? "web-0",
    },
    ...(overrides.responseCode === undefined
      ? {}
      : { responseStatus: { code: overrides.responseCode } }),
    ...(overrides.responseBody === undefined
      ? {}
      : { responseObject: overrides.responseBody }),
    requestReceivedTimestamp:
      overrides.requestReceivedTimestamp ?? "2026-11-20T10:00:00.000000Z",
  });

const writeLog = async (name: string, text: string): Promise<string> => {
  const directory = await createTestTempDirectory("rea-kubernetes-audit-");
  const path = join(directory, name);
  await writeFile(path, text);
  return path;
};

const metadataOf = async (text: string) => {
  const reader = new KubernetesAuditLogArtifactReader(
    await writeLog("audit.log", text),
  );
  // The log declares no members, so the traversal only builds the inventory
  // and reports what it could not establish through the coverage callback.
  const limitations: string[] = [];
  try {
    for await (const _entry of reader.entries(undefined, {
      onCoverage: (coverage) => limitations.push(...coverage.limitations),
    })) {
      // No members.
    }
    const metadata = reader.formatMetadata();
    if (metadata?.kind !== "kubernetes-audit-log")
      throw new Error("Expected kubernetes-audit-log metadata");
    return { ...metadata, limitations };
  } finally {
    await reader.close();
  }
};

const REQUEST = [
  auditEvent({ stage: "RequestReceived" }),
  auditEvent({ stage: "ResponseStarted", responseCode: 200 }),
  auditEvent({ stage: "ResponseComplete", responseCode: 200 }),
].join("\n");

it("joins the stages of one request on its auditID", async () => {
  const metadata = await metadataOf(`${REQUEST}\n`);
  expect(metadata.line_count).toBe(3);
  expect(metadata.event_count).toBe(3);
  expect(metadata.events).toHaveLength(1);
  const [event] = metadata.events;
  expect(event?.audit_id).toBe("00000000-0000-4000-8000-000000000001");
  expect(event?.stages.map((stage) => stage.stage)).toEqual([
    "RequestReceived",
    "ResponseStarted",
    "ResponseComplete",
  ]);
  expect(event?.stages.map((stage) => stage.line)).toEqual([1, 2, 3]);
  expect(event?.request_uri).toBe("/api/v1/namespaces/default/pods");
  expect(event?.verb).toBe("get");
  expect(event?.username).toBe("system:serviceaccount:default:reader");
  expect(event?.user_groups).toEqual([
    "system:serviceaccounts",
    "system:authenticated",
  ]);
  expect(event?.source_ips).toEqual(["10.0.0.7"]);
  expect(event?.user_agent).toBe("kubectl/v1.30.0");
  expect(event?.resource).toBe("pods");
  expect(event?.namespace).toBe("default");
  expect(event?.object_name).toBe("web-0");
  expect(event?.response_code).toBe(200);
  expect(event?.response_code_line).toBe(2);
  expect(event?.stages.map((stage) => stage.response_code)).toEqual([
    null,
    200,
    200,
  ]);
  expect(event?.unsupported_version).toBe(false);
  expect(metadata.sample_missing_terminal_stage_count).toBe(0);
  expect(metadata.unsampled_event_line_count).toBe(0);
  expect(metadata.sample_duplicate_stage_line_count).toBe(0);
});

it("counts stage and verb totals across every line", async () => {
  const metadata = await metadataOf(
    [
      auditEvent({
        auditID: "00000000-0000-4000-8000-00000000000a",
        verb: "get",
      }),
      auditEvent({
        auditID: "00000000-0000-4000-8000-00000000000b",
        stage: "ResponseComplete",
        verb: "delete",
        responseCode: 403,
      }),
    ].join("\n"),
  );
  expect(metadata.stage_counts).toEqual([
    { label: "RequestReceived", count: 1 },
    { label: "ResponseComplete", count: 1 },
  ]);
  expect(metadata.verb_counts).toEqual([
    { label: "delete", count: 1 },
    { label: "get", count: 1 },
  ]);
  expect(metadata.events.map((event) => event.audit_id)).toEqual([
    "00000000-0000-4000-8000-00000000000a",
    "00000000-0000-4000-8000-00000000000b",
  ]);
  expect(metadata.events[1]?.response_code).toBe(403);
  expect(metadata.sample_missing_terminal_stage_count).toBe(1);
});

it("keeps a stage the API does not define out of the inventory as a diagnostic", async () => {
  const metadata = await metadataOf(
    [
      auditEvent(),
      JSON.stringify({
        auditID: "00000000-0000-4000-8000-00000000000c",
        stage: "Started",
      }),
      "not json at all",
      "",
    ].join("\n"),
  );
  expect(metadata.event_count).toBe(1);
  expect(metadata.malformed_line_count).toBe(2);
  expect(metadata.malformed_lines.map((line) => line.line)).toEqual([2, 3]);
  expect(metadata.malformed_lines.map((line) => line.excerpt)).toEqual([
    JSON.stringify({
      auditID: "00000000-0000-4000-8000-00000000000c",
      stage: "Started",
    }),
    "not json at all",
  ]);
});

it("keeps a malformed line between two valid events from stopping the scan", async () => {
  const metadata = await metadataOf(
    [
      auditEvent({ auditID: "00000000-0000-4000-8000-00000000000d" }),
      "{truncated",
      auditEvent({
        auditID: "00000000-0000-4000-8000-00000000000e",
        stage: "ResponseComplete",
      }),
    ].join("\n"),
  );
  expect(metadata.event_count).toBe(2);
  expect(metadata.malformed_line_count).toBe(1);
  expect(metadata.events.map((event) => event.audit_id)).toEqual([
    "00000000-0000-4000-8000-00000000000d",
    "00000000-0000-4000-8000-00000000000e",
  ]);
});

it("counts a repeated stage for one auditID without dropping the line", async () => {
  const metadata = await metadataOf(
    [
      auditEvent({ stage: "ResponseComplete", responseCode: 200 }),
      auditEvent({ stage: "ResponseComplete", responseCode: 500 }),
    ].join("\n"),
  );
  expect(metadata.event_count).toBe(2);
  expect(metadata.sample_duplicate_stage_line_count).toBe(1);
  expect(metadata.events).toHaveLength(1);
  expect(metadata.events[0]?.stages.map((stage) => stage.line)).toEqual([1, 2]);
  expect(
    metadata.events[0]?.stages.map((stage) => stage.response_code),
  ).toEqual([200, 500]);
});

it("retains the first late terminal stage and accounts for every discarded repeat", async () => {
  const metadata = await metadataOf(
    [
      auditEvent(),
      auditEvent(),
      auditEvent(),
      auditEvent(),
      auditEvent({ stage: "ResponseComplete", responseCode: 403 }),
      auditEvent({ stage: "ResponseComplete", responseCode: 500 }),
    ].join("\n"),
  );
  const [event] = metadata.events;
  expect(
    event?.stages.map(({ line, response_code }) => [line, response_code]),
  ).toEqual([
    [1, null],
    [2, null],
    [3, null],
    [5, 403],
  ]);
  expect(event?.omitted_stage_lines).toBe(2);
  expect(metadata.sample_duplicate_stage_line_count).toBe(4);
  expect(metadata.sample_missing_terminal_stage_count).toBe(0);
});

it("treats a recorded Panic as terminal even when earlier stages are absent", async () => {
  const metadata = await metadataOf(
    auditEvent({ stage: "Panic", responseCode: 500 }),
  );
  expect(metadata.sample_missing_terminal_stage_count).toBe(0);
  expect(metadata.events[0]?.stages).toMatchObject([
    { stage: "Panic", response_code: 500 },
  ]);
});

it("reads a safe response code written with a very long zero fraction", async () => {
  const metadata = await metadataOf(
    `${auditEvent({
      stage: "ResponseComplete",
      responseCode: 200,
    }).replace('"code":200', `"code":200.${"0".repeat(80)}`)}\n`,
  );
  expect(metadata.events[0]?.response_code).toBe(200);
});

it("reads a safe response code written with a long zero fraction", async () => {
  const metadata = await metadataOf(
    `${auditEvent({
      stage: "ResponseComplete",
      responseCode: 200,
    }).replace('"code":200', '"code":200.00000000000000000')}\n`,
  );
  expect(metadata.events[0]?.response_code).toBe(200);
  expect(metadata.events[0]?.stages[0]?.response_code).toBe(200);
});

it("keeps the widest safe integral response code", async () => {
  const metadata = await metadataOf(
    [
      auditEvent({
        stage: "ResponseStarted",
        responseCode: Number.MAX_SAFE_INTEGER,
      }),
      auditEvent({
        stage: "ResponseComplete",
        responseCode: -Number.MAX_SAFE_INTEGER,
      }),
    ].join("\n"),
  );
  expect(
    metadata.events[0]?.stages.map((stage) => stage.response_code),
  ).toEqual([Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]);
  expect(metadata.events[0]?.response_code).toBe(Number.MAX_SAFE_INTEGER);
});

it.each([
  ["2e2", 200],
  ["-2e2", -200],
  ["2.01e2", 201],
  ["0.2e3", 200],
  ["2.5e2", 250],
  ["2.010e2", 201],
  [`200.${"0".repeat(80)}`, 200],
  [`0.${"0".repeat(41)}2e44`, 200],
])(
  "keeps the safe integer a long number lexeme evaluates to (%s)",
  async (lexeme, expected) => {
    const encoded = auditEvent({ stage: "ResponseStarted" }).replace(
      '"stage":"ResponseStarted"',
      `"stage":"ResponseStarted","responseStatus":{"code":${lexeme}}`,
    );
    const metadata = await metadataOf(
      [
        encoded,
        auditEvent({ stage: "ResponseComplete", responseCode: 403 }),
      ].join("\n"),
    );
    expect(
      metadata.events[0]?.stages.map((stage) => stage.response_code),
    ).toEqual([expected, 403]);
    expect(metadata.events[0]?.response_code).toBe(expected);
  },
);

it("drops a fractional status code whose exponent does not make it integral", async () => {
  const metadata = await metadataOf(
    [
      auditEvent({ stage: "ResponseStarted" }).replace(
        '"stage":"ResponseStarted"',
        '"stage":"ResponseStarted","responseStatus":{"code":2.5e0}',
      ),
      auditEvent({ stage: "ResponseComplete", responseCode: 403 }),
    ].join("\n"),
  );
  expect(
    metadata.events[0]?.stages.map((stage) => stage.response_code),
  ).toEqual([null, 403]);
  expect(metadata.events[0]?.response_code).toBe(403);
});

it("drops a status code whose value is not a safe integer", async () => {
  const metadata = await metadataOf(
    auditEvent({
      stage: "ResponseComplete",
      responseCode: Number.MAX_SAFE_INTEGER + 2,
    }),
  );
  expect(metadata.events[0]?.response_code).toBeNull();
});

it("retains valid response facts when another stage has a fractional response code", async () => {
  const metadata = await metadataOf(
    [
      auditEvent({ stage: "ResponseStarted", responseCode: 200.5 }),
      auditEvent({ stage: "ResponseComplete", responseCode: 403 }),
    ].join("\n"),
  );
  expect(
    metadata.events[0]?.stages.map((stage) => stage.response_code),
  ).toEqual([null, 403]);
  expect(metadata.events[0]?.response_code).toBe(403);
});

it.each(["audit.k8s.io/v0", null])(
  "does not interpret an unmodelled audit API version (%s)",
  async (apiVersion) => {
    const metadata = await metadataOf(
      `${JSON.stringify({
        kind: "Event",
        apiVersion,
        auditID: "00000000-0000-4000-8000-00000000000f",
        stage: "RequestReceived",
        requestURI: "/api/v1/pods",
        verb: "list",
        responseStatus: { code: 200 },
        requestReceivedTimestamp: "2026-11-20T10:00:00Z",
      })}\n`,
    );
    const [event] = metadata.events;
    expect(event?.unsupported_version).toBe(true);
    expect(event?.audit_id).toBe("00000000-0000-4000-8000-00000000000f");
    expect(event?.stages.map((stage) => stage.stage)).toEqual([
      "RequestReceived",
    ]);
    expect(event?.request_uri).toBeNull();
    expect(event?.verb).toBeNull();
    expect(event?.response_code).toBeNull();
    expect(event?.stages[0]).toMatchObject({
      request_received_timestamp: null,
      response_code: null,
    });
    expect(metadata.verb_counts).toEqual([]);
  },
);

it("reads request fields from the first modelled stage of a mixed-version auditID", async () => {
  const metadata = await metadataOf(
    [
      JSON.stringify({
        apiVersion: "audit.k8s.io/v9",
        auditID: "mixed-early",
        stage: "RequestReceived",
        verb: "delete",
        requestURI: "/secret",
        requestReceivedTimestamp: "2026-11-20T10:00:00Z",
      }),
      JSON.stringify({
        apiVersion: "audit.k8s.io/v1",
        auditID: "mixed-early",
        stage: "ResponseComplete",
        verb: "get",
        requestURI: "/api/v1/pods",
        responseStatus: { code: 403 },
        requestReceivedTimestamp: "2026-11-20T10:00:01Z",
      }),
      JSON.stringify({
        apiVersion: "audit.k8s.io/v1",
        auditID: "mixed-late",
        stage: "RequestReceived",
        verb: "list",
        requestURI: "/api/v1/namespaces",
      }),
      JSON.stringify({
        apiVersion: "audit.k8s.io/v9",
        auditID: "mixed-late",
        stage: "ResponseComplete",
        verb: "delete",
        requestURI: "/secret",
        responseStatus: { code: 500 },
      }),
    ].join("\n"),
  );
  expect(metadata.events.map((event) => event.audit_id)).toEqual([
    "mixed-early",
    "mixed-late",
  ]);
  expect(metadata.events[0]).toMatchObject({
    unsupported_version: true,
    verb: "get",
    request_uri: "/api/v1/pods",
    response_code: 403,
    response_code_line: 2,
  });
  expect(metadata.events[0]?.stages).toMatchObject([
    {
      stage: "RequestReceived",
      line: 1,
      response_code: null,
      request_received_timestamp: null,
    },
    {
      stage: "ResponseComplete",
      line: 2,
      response_code: 403,
      request_received_timestamp: Date.parse("2026-11-20T10:00:01Z"),
    },
  ]);
  expect(metadata.events[1]).toMatchObject({
    unsupported_version: true,
    verb: "list",
    request_uri: "/api/v1/namespaces",
    response_code: null,
  });
  expect(metadata.verb_counts).toEqual([
    { label: "get", count: 1 },
    { label: "list", count: 1 },
  ]);
});

it("reads a log that begins with blank lines or a UTF-8 BOM", async () => {
  const metadata = await metadataOf(`\n\n\uFEFF${auditEvent()}\n`);
  expect(metadata.line_count).toBe(3);
  expect(metadata.event_count).toBe(1);
  expect(metadata.malformed_line_count).toBe(0);
  expect(metadata.events[0]?.request_uri).toBe(
    "/api/v1/namespaces/default/pods",
  );
});

it("reads an optional field it did not get as null, not as empty text", async () => {
  const metadata = await metadataOf(
    `${JSON.stringify({
      kind: "Event",
      auditID: "00000000-0000-4000-8000-000000000010",
      stage: "RequestReceived",
    })}\n`,
  );
  const [event] = metadata.events;
  expect(event?.request_uri).toBeNull();
  expect(event?.verb).toBeNull();
  expect(event?.username).toBeNull();
  expect(event?.user_groups).toBeNull();
  expect(event?.source_ips).toBeNull();
  expect(event?.resource).toBeNull();
  expect(event?.response_code).toBeNull();
  expect(event?.stages[0]?.request_received_timestamp).toBeNull();
});

it("preserves explicitly empty groups and source IP arrays", async () => {
  const metadata = await metadataOf(auditEvent({ groups: [], sourceIPs: [] }));
  expect(metadata.events[0]).toMatchObject({ user_groups: [], source_ips: [] });
});

it("parses the event's own requestReceivedTimestamp", async () => {
  const metadata = await metadataOf(
    `${auditEvent({ requestReceivedTimestamp: "2026-11-20T10:00:00.000000Z" })}\n`,
  );
  expect(metadata.events[0]?.stages[0]?.request_received_timestamp).toBe(
    Date.parse("2026-11-20T10:00:00.000Z"),
  );
});

it("keeps unstructured timestamps unknown", async () => {
  const metadata = await metadataOf(
    auditEvent({ requestReceivedTimestamp: "1" }),
  );
  expect(metadata.events[0]?.stages[0]?.request_received_timestamp).toBeNull();
});

it("samples a bounded window of events while totals cover the whole file", async () => {
  const lines = Array.from(
    { length: KUBERNETES_AUDIT_INLINE_EVENT_LIMIT + 5 },
    (_value, index) =>
      auditEvent({
        auditID: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      }),
  );
  const metadata = await metadataOf(`${lines.join("\n")}\n`);
  expect(metadata.event_count).toBe(KUBERNETES_AUDIT_INLINE_EVENT_LIMIT + 5);
  expect(metadata.events).toHaveLength(KUBERNETES_AUDIT_INLINE_EVENT_LIMIT);
  expect(metadata.unsampled_event_line_count).toBe(5);
  expect(metadata.events[0]?.audit_id).toBe(
    "00000000-0000-4000-8000-000000000000",
  );
});

it("bounds retained request text and verb labels while stage totals cover the log", async () => {
  const first = auditEvent({
    auditID: "first",
    userAgent: "x".repeat(128 * 1024),
    verb: "get",
  });
  const next = Array.from(
    { length: KUBERNETES_AUDIT_INLINE_VERB_LIMIT },
    (_value, index) =>
      auditEvent({
        auditID: `id-${String(index)}`,
        verb: `verb-${String(index)}`,
      }),
  );
  const complete = auditEvent({
    auditID: "first",
    stage: "ResponseComplete",
    verb: "get",
    responseCode: 403,
  });
  const metadata = await metadataOf([first, ...next, complete].join("\n"));
  expect(metadata.events[0]).toMatchObject({
    audit_id: "first",
    user_agent: null,
    request_uri: "/api/v1/namespaces/default/pods",
    request_fields_omitted: true,
    response_code: 403,
  });
  expect(metadata.verb_counts).toHaveLength(KUBERNETES_AUDIT_INLINE_VERB_LIMIT);
  expect(metadata.verb_counts).toContainEqual({ label: "get", count: 2 });
  expect(metadata.unlisted_verb_line_count).toBe(1);
  expect(metadata.unsampled_event_line_count).toBe(1);
  expect(metadata.event_count).toBe(next.length + 2);
});

it("skips an ignored body and still reads fields written after it", async () => {
  const nest = `${"[".repeat(8)}1${"]".repeat(8)}`;
  const metadata = await metadataOf(
    `{"auditID":"ordered","stage":"ResponseComplete","requestObject":${nest},"requestURI":"/after","verb":"list","responseStatus":{"code":201},"user":{"username":"ada","groups":["system:authenticated"]}}\n`,
  );
  expect(metadata.malformed_line_count).toBe(0);
  expect(metadata.events[0]).toMatchObject({
    audit_id: "ordered",
    request_uri: "/after",
    verb: "list",
    username: "ada",
    user_groups: ["system:authenticated"],
    response_code: 201,
    stages: [{ stage: "ResponseComplete" }],
  });
});

it("keeps owned fields when an ignored body exceeds the nesting bound", async () => {
  const nest = `${"[".repeat(KUBERNETES_AUDIT_JSON_DEPTH)}1${"]".repeat(KUBERNETES_AUDIT_JSON_DEPTH)}`;
  const deep = `{"apiVersion":"audit.k8s.io/v1","auditID":"deep","stage":"RequestReceived","requestURI":"/api/v1/pods","verb":"get","requestObject":${nest}}`;
  const hidden = `{"requestObject":${nest},"auditID":"hidden","stage":"RequestReceived","requestURI":"/hidden"}`;
  const metadata = await metadataOf(
    `${deep}\n${hidden}\n${auditEvent({
      auditID: "after",
      stage: "ResponseComplete",
      responseCode: 200,
    })}\n`,
  );
  expect(metadata.events.map((event) => event.audit_id)).toEqual([
    "deep",
    "after",
  ]);
  expect(metadata.events[0]).toMatchObject({
    request_uri: "/api/v1/pods",
    verb: "get",
    unsupported_version: false,
    depth_limited: true,
  });
  expect(metadata.events[1]?.depth_limited).toBe(false);
  expect(metadata.malformed_line_count).toBe(0);
  expect(metadata.depth_limited_line_count).toBe(2);
  expect(metadata.event_count).toBe(2);
});

it("leaves a wrong-shaped version or address list unknown", async () => {
  const metadata = await metadataOf(
    [
      '{"apiVersion":{},"auditID":"shaped","stage":"RequestReceived","verb":"get","requestURI":"/secret"}',
      '{"apiVersion":"audit.k8s.io/v1","auditID":"addrs","stage":"ResponseComplete","sourceIPs":["10.0.0.1",{}],"verb":"get"}',
    ].join("\n"),
  );
  expect(metadata.events[0]).toMatchObject({
    audit_id: "shaped",
    unsupported_version: true,
    verb: null,
    request_uri: null,
  });
  expect(metadata.events[1]).toMatchObject({
    audit_id: "addrs",
    unsupported_version: false,
    source_ips: null,
    verb: "get",
  });
  expect(metadata.malformed_line_count).toBe(0);
});

it("does not retain a source address list past the list text budget", async () => {
  const addresses = Array.from({ length: 5000 }, () => "10.0.0.1");
  const metadata = await metadataOf(
    `${JSON.stringify({
      apiVersion: "audit.k8s.io/v1",
      auditID: "many-ips",
      stage: "RequestReceived",
      verb: "get",
      requestURI: "/api",
      sourceIPs: addresses,
    })}\n`,
  );
  expect(metadata.events[0]).toMatchObject({
    audit_id: "many-ips",
    request_uri: "/api",
    verb: "get",
    source_ips: null,
    request_fields_omitted: true,
  });
});

it("does not interpret fields when the depth cap hides apiVersion", async () => {
  const nest = `${"[".repeat(KUBERNETES_AUDIT_JSON_DEPTH)}1${"]".repeat(KUBERNETES_AUDIT_JSON_DEPTH)}`;
  const metadata = await metadataOf(
    `{"auditID":"cut","stage":"RequestReceived","verb":"delete","requestURI":"/secret","requestObject":${nest},"apiVersion":"audit.k8s.io/v100"}\n`,
  );
  expect(metadata.events[0]).toMatchObject({
    audit_id: "cut",
    verb: null,
    request_uri: null,
    depth_limited: true,
    unsupported_version: false,
  });
  expect(metadata.verb_counts).toEqual([]);
});

it("clears a response object when a later array replaces it", async () => {
  const metadata = await metadataOf(
    '{"auditID":"replaced-array","stage":"ResponseComplete","responseStatus":{"code":403},"responseStatus":[],"verb":"get"}\n',
  );
  expect(metadata.events[0]).toMatchObject({
    audit_id: "replaced-array",
    verb: "get",
    response_code: null,
  });
});

it("drops an address list when a later list is cut off by depth", async () => {
  const nest = `${"[".repeat(KUBERNETES_AUDIT_JSON_DEPTH)}1${"]".repeat(KUBERNETES_AUDIT_JSON_DEPTH)}`;
  const metadata = await metadataOf(
    `{"apiVersion":"audit.k8s.io/v1","auditID":"ips","stage":"RequestReceived","verb":"get","sourceIPs":["10.0.0.1"],"sourceIPs":${nest}}\n`,
  );
  expect(metadata.events[0]).toMatchObject({
    audit_id: "ips",
    source_ips: null,
    verb: "get",
    depth_limited: true,
  });
});

it("clears groups when a later scalar replaces the list", async () => {
  const metadata = await metadataOf(
    '{"auditID":"groups","stage":"RequestReceived","user":{"username":"ada","groups":["system:authenticated"]},"user":{"username":"ada","groups":null},"verb":"get"}\n',
  );
  expect(metadata.events[0]).toMatchObject({
    audit_id: "groups",
    username: "ada",
    user_groups: null,
    verb: "get",
  });
});

it("does not clear a nested omission from a same-named top-level key", async () => {
  const metadata = await metadataOf(
    `{"apiVersion":"audit.k8s.io/v1","auditID":"nested","stage":"RequestReceived","requestURI":"/api","verb":"get","user":{"username":"${"x".repeat(200_000)}"},"user.username":null}\n`,
  );
  expect(metadata.events[0]).toMatchObject({
    audit_id: "nested",
    request_uri: "/api",
    username: null,
    request_fields_omitted: true,
  });
});

it("clears budget omission when a later null replaces an address list", async () => {
  const addresses = Array.from({ length: 5000 }, () => "10.0.0.1");
  const first = JSON.stringify({
    apiVersion: "audit.k8s.io/v1",
    auditID: "ips-null",
    stage: "RequestReceived",
    verb: "get",
    requestURI: "/api",
    sourceIPs: addresses,
  });
  const metadata = await metadataOf(
    `${first.slice(0, -1)},"sourceIPs":null}\n`,
  );
  expect(metadata.events[0]).toMatchObject({
    audit_id: "ips-null",
    request_uri: "/api",
    source_ips: null,
    request_fields_omitted: false,
  });
});

it("clears budget omission when a later object replaces an address list", async () => {
  const addresses = Array.from({ length: 5000 }, () => "10.0.0.1");
  const first = JSON.stringify({
    apiVersion: "audit.k8s.io/v1",
    auditID: "ips-object",
    stage: "RequestReceived",
    verb: "get",
    requestURI: "/api",
    sourceIPs: addresses,
  });
  const metadata = await metadataOf(`${first.slice(0, -1)},"sourceIPs":{}}\n`);
  expect(metadata.events[0]).toMatchObject({
    audit_id: "ips-object",
    request_uri: "/api",
    source_ips: null,
    request_fields_omitted: false,
  });
});

it("clears budget omission when a later null replaces the value", async () => {
  const metadata = await metadataOf(
    `{"apiVersion":"audit.k8s.io/v1","auditID":"agent-null","stage":"RequestReceived","requestURI":"/api","verb":"get","userAgent":"${"x".repeat(200_000)}","userAgent":null}\n`,
  );
  expect(metadata.events[0]).toMatchObject({
    audit_id: "agent-null",
    request_uri: "/api",
    verb: "get",
    user_agent: null,
    request_fields_omitted: false,
  });
});

it("keeps a small duplicate after an over-budget value", async () => {
  const metadata = await metadataOf(
    `{"apiVersion":"audit.k8s.io/v1","auditID":"agent","stage":"RequestReceived","requestURI":"/api","verb":"get","userAgent":"${"x".repeat(200_000)}","userAgent":"kubectl"}\n`,
  );
  expect(metadata.events[0]).toMatchObject({
    audit_id: "agent",
    request_uri: "/api",
    verb: "get",
    user_agent: "kubectl",
    request_fields_omitted: false,
  });
});

it("drops a response object when a later value replaces it", async () => {
  const metadata = await metadataOf(
    '{"auditID":"replaced","stage":"ResponseComplete","responseStatus":{"code":403},"responseStatus":null,"verb":"get"}\n',
  );
  expect(metadata.events[0]).toMatchObject({
    audit_id: "replaced",
    verb: "get",
    response_code: null,
    response_code_line: null,
  });
});

it("does not read audit identity from inside an ignored body", async () => {
  const metadata = await metadataOf(
    '{"auditID":"top","stage":"RequestReceived","requestURI":"/top","requestObject":{"auditID":"nested","stage":"Panic","verb":"delete"}}\n',
  );
  expect(metadata.events[0]).toMatchObject({
    audit_id: "top",
    request_uri: "/top",
    verb: null,
    stages: [{ stage: "RequestReceived" }],
  });
  expect(metadata.stage_counts).toEqual([
    { label: "RequestReceived", count: 1 },
  ]);
});

it("retains small request fields alongside an ignored response body", async () => {
  const metadata = await metadataOf(
    auditEvent({
      stage: "ResponseComplete",
      responseCode: 403,
      responseBody: { data: "x".repeat(200 * 1024) },
    }),
  );
  expect(metadata.events[0]).toMatchObject({
    request_uri: "/api/v1/namespaces/default/pods",
    username: "system:serviceaccount:default:reader",
    user_groups: ["system:serviceaccounts", "system:authenticated"],
    source_ips: ["10.0.0.7"],
    response_code: 403,
    request_fields_omitted: false,
  });
});

it("bounds the inline diagnostics while counting every malformed line", async () => {
  const lines = Array.from(
    { length: KUBERNETES_AUDIT_INLINE_DIAGNOSTIC_LIMIT + 3 },
    (_value, index) => `{"line":${String(index)}}`,
  );
  const metadata = await metadataOf(`${[auditEvent(), ...lines].join("\n")}\n`);
  expect(metadata.malformed_line_count).toBe(
    KUBERNETES_AUDIT_INLINE_DIAGNOSTIC_LIMIT + 3,
  );
  expect(metadata.malformed_lines).toHaveLength(
    KUBERNETES_AUDIT_INLINE_DIAGNOSTIC_LIMIT,
  );
  expect(metadata.omitted_malformed_lines).toBe(3);
});

it("reports a trailing line that the file ended without a newline", async () => {
  const metadata = await metadataOf(`${auditEvent()}`);
  expect(metadata.trailing_bytes).toBeGreaterThan(0);
  expect(metadata.event_count).toBe(1);
});

it("counts the full size of an overlong unterminated line without retaining it", async () => {
  const trailing = "x".repeat(4 * 1024 * 1024 + 128 * 1024);
  const metadata = await metadataOf(`${auditEvent()}\n${trailing}`);
  expect(metadata.trailing_bytes).toBe(trailing.length);
  expect(metadata.oversized_line_count).toBe(1);
  expect(metadata.malformed_line_count).toBe(0);
  expect(metadata.event_count).toBe(1);
  expect(metadata.line_bytes_limit).toBe(4 * 1024 * 1024);
  expect(metadata.events).toHaveLength(1);
});

it("refuses a file whose lines are not audit events as malformed", async () => {
  const reader = new KubernetesAuditLogArtifactReader(
    await writeLog("audit.log", "hello\nworld\n"),
  );
  try {
    await expect(async () => {
      for await (const _entry of reader.entries()) {
        // No members.
      }
    }).rejects.toMatchObject({ reason: "malformed" });
  } finally {
    await reader.close();
  }
});

it("reports cancellation requested from the coverage callback", async () => {
  const reader = new KubernetesAuditLogArtifactReader(
    await writeLog("audit.log", `${REQUEST}\n`),
  );
  const controller = new AbortController();
  try {
    const entries = reader
      .entries(controller.signal, {
        onCoverage: () => controller.abort(),
      })
      [Symbol.asyncIterator]();
    await expect(entries.next()).rejects.toMatchObject({ reason: "cancelled" });
  } finally {
    await reader.close();
  }
});

it("reports no members to open", async () => {
  const reader = new KubernetesAuditLogArtifactReader(
    await writeLog("audit.log", `${REQUEST}\n`),
  );
  await expect(
    reader.open({
      path: "audit.log",
      kind: "file",
      declaredSize: null,
      compressedSize: null,
      executable: false,
      encrypted: false,
      byteOffset: null,
      declaredIntegrity: null,
      unpacked: false,
      limitations: [],
      adapterKey: "root",
    }),
  ).rejects.toMatchObject({ reason: "unavailable" });
  await reader.close();
});

it("does not count a dropped verb when the audit version was not read", async () => {
  const nest = `${"[".repeat(KUBERNETES_AUDIT_JSON_DEPTH)}1${"]".repeat(KUBERNETES_AUDIT_JSON_DEPTH)}`;
  const cut = `{"auditID":"cut-verb","stage":"RequestReceived","verb":"${"v".repeat(200_000)}","requestObject":${nest}}`;
  const metadata = await metadataOf(`${cut}\n${auditEvent({ verb: "get" })}\n`);
  expect(metadata.depth_limited_line_count).toBe(1);
  expect(metadata.unlisted_verb_line_count).toBe(0);
  expect(metadata.verb_counts).toEqual([{ label: "get", count: 1 }]);
  expect(metadata.events[0]).toMatchObject({
    audit_id: "cut-verb",
    verb: null,
    depth_limited: true,
  });
});

it("counts a dropped verb on an interpreted audit line as unlisted", async () => {
  const metadata = await metadataOf(
    `${auditEvent({ verb: "v".repeat(200_000) })}\n`,
  );
  expect(metadata.unlisted_verb_line_count).toBe(1);
  expect(metadata.verb_counts).toEqual([]);
  expect(metadata.events[0]?.verb).toBeNull();
  expect(metadata.events[0]?.request_fields_omitted).toBe(true);
});

it("fills request fields from a readable stage after a depth-cut first one", async () => {
  const nest = `${"[".repeat(KUBERNETES_AUDIT_JSON_DEPTH)}1${"]".repeat(KUBERNETES_AUDIT_JSON_DEPTH)}`;
  const cut = `{"auditID":"late-fill","stage":"RequestReceived","requestObject":${nest},"apiVersion":"audit.k8s.io/v1"}`;
  const readable = auditEvent({
    auditID: "late-fill",
    stage: "ResponseComplete",
    requestURI: "/api/v1/namespaces/default/pods",
    verb: "delete",
    username: "ada",
    responseCode: 403,
  });
  const metadata = await metadataOf(`${cut}\n${readable}\n`);
  expect(metadata.events[0]).toMatchObject({
    audit_id: "late-fill",
    request_uri: "/api/v1/namespaces/default/pods",
    verb: "delete",
    username: "ada",
    response_code: 403,
    depth_limited: true,
  });
});
