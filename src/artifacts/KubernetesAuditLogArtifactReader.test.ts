import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { KubernetesAuditLogArtifactReader } from "./KubernetesAuditLogArtifactReader.js";
import {
  KUBERNETES_AUDIT_INLINE_DIAGNOSTIC_LIMIT,
  KUBERNETES_AUDIT_INLINE_EVENT_LIMIT,
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
  expect(event?.response_code).toBeNull();
  expect(event?.unsupported_version).toBe(false);
  expect(metadata.incomplete_stage_event_count).toBe(1);
  expect(metadata.duplicate_stage_line_count).toBe(0);
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
  expect(metadata.duplicate_stage_line_count).toBe(1);
  expect(metadata.events).toHaveLength(1);
  expect(metadata.events[0]?.stages.map((stage) => stage.line)).toEqual([1, 2]);
});

it("does not interpret an audit API version this reader does not model", async () => {
  const metadata = await metadataOf(
    `${JSON.stringify({
      kind: "Event",
      apiVersion: "audit.k8s.io/v0",
      auditID: "00000000-0000-4000-8000-00000000000f",
      stage: "RequestReceived",
      requestURI: "/api/v1/pods",
      verb: "list",
      responseStatus: { code: 200 },
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
  expect(
    metadata.limitations.some((line) => line.includes("does not model")),
  ).toBe(true);
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
  expect(event?.user_groups).toEqual([]);
  expect(event?.source_ips).toEqual([]);
  expect(event?.resource).toBeNull();
  expect(event?.response_code).toBeNull();
  expect(event?.stages[0]?.request_received_timestamp).toBeNull();
});

it("parses the event's own requestReceivedTimestamp", async () => {
  const metadata = await metadataOf(
    `${auditEvent({ requestReceivedTimestamp: "2026-11-20T10:00:00.000000Z" })}\n`,
  );
  expect(metadata.events[0]?.stages[0]?.request_received_timestamp).toBe(
    Date.parse("2026-11-20T10:00:00.000Z"),
  );
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
  expect(metadata.omitted_events).toBe(5);
  expect(
    metadata.limitations.some((line) =>
      line.includes(`${KUBERNETES_AUDIT_INLINE_EVENT_LIMIT} auditID(s)`),
    ),
  ).toBe(true);
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
