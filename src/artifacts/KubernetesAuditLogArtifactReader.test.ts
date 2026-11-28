import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { KubernetesAuditLogArtifactReader } from "./KubernetesAuditLogArtifactReader.js";
import {
  KUBERNETES_AUDIT_INLINE_DIAGNOSTIC_LIMIT,
  KUBERNETES_AUDIT_INLINE_EVENT_LIMIT,
  KUBERNETES_AUDIT_INLINE_VERB_LIMIT,
} from "../domain/linux/kubernetesAuditLog.js";
import { ArtifactReaderFailure } from "../resources/ArtifactReader.js";
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
  expect(metadata.malformed_lines[0]?.reason).toContain("unknown stage");
  expect(metadata.malformed_lines[1]?.reason).toContain("not JSON");
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
    expect(
      metadata.limitations.some((line) => line.includes("does not model")),
    ).toBe(true);
  },
);

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
  expect(
    metadata.limitations.some((line) =>
      line.includes(`${KUBERNETES_AUDIT_INLINE_EVENT_LIMIT} auditID(s)`),
    ),
  ).toBe(true);
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
  expect(metadata.limitations).toEqual(
    expect.arrayContaining([
      expect.stringContaining(
        `artifact_limits.kubernetes_audit_log.line_bytes to at least ${String(trailing.length)}`,
      ),
    ]),
  );
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
  ).rejects.toBeInstanceOf(ArtifactReaderFailure);
  await reader.close();
});
