import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, test } from "vitest";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { loadConfiguredPermissionAuthority } from "../../../src/application/PermissionConfiguration.js";
import { observeJavaScriptRuntime } from "../../../src/application/JavaScriptRuntimeObservationService.js";
import { V8InspectorProvider } from "../../../src/browser/V8InspectorProvider.js";
import { parseConfig } from "../../../src/config.js";
import { createServer } from "../../../src/server/createServer.js";
import { observed } from "../../fixtures/analysisExecution.js";
import { startFakeV8Inspector } from "../../fixtures/fakeV8Inspector.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("JavaScript runtime observation MCP tools", () => {
  const resources: Array<{ close(): Promise<unknown> }> = [];
  const temporary: string[] = [];

  afterEach(async () => {
    await Promise.all(resources.splice(0).map((item) => item.close()));
    await Promise.all(
      temporary
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  test("lists and observes one target as retained Evidence", async () => {
    const root = await createTestTempDirectory("rea-v8-mcp-");
    temporary.push(root);
    const entry = join(root, "entry.js");
    await writeFile(entry, "export const value = 1;\n");
    const inspector = await startFakeV8Inspector({
      targetUrl: pathToFileURL(entry).href,
    });
    resources.push(inspector);
    const config = parseConfig({
      REA_V8_INSPECTOR_OBSERVE_ENABLED: "true",
      REA_V8_INSPECTOR_ENDPOINTS_JSON: JSON.stringify([inspector.endpoint]),
      REA_V8_INSPECTOR_FILE_ROOTS_JSON: JSON.stringify([root]),
    });
    if (!config.ok) throw config.error;
    const authority = await loadConfiguredPermissionAuthority(config.value);
    if (!authority.ok) throw authority.error;
    const session = createTestBinarySession(() => ({
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(),
    }));
    const server = createServer(session, session, {
      javascriptRuntimeObservation: new V8InspectorProvider(),
      permissionAuthority: authority.value,
      availabilityPolicy: () => ({
        processCaptureEnabled: false,
        evidenceFileRoots: 0,
        investigationInputRoots: 0,
        v8InspectorObservationEnabled: true,
      }),
    });
    const client = new Client({ name: "v8-mcp-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    resources.push(client, server, session);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.callTool({
      name: "list_javascript_runtime_targets",
      arguments: {
        inspector_endpoint: inspector.endpoint,
        allowed_file_roots: [root],
        allowed_origins: [],
        approved: true,
      },
    });
    expect(listed.isError).not.toBe(true);
    expect(listed.structuredContent).toMatchObject({
      result: {
        targets: { items: [{ target_id: inspector.targetId }] },
      },
    });

    const observedRuntime = await client.callTool({
      name: "observe_javascript_runtime",
      arguments: {
        inspector_endpoint: inspector.endpoint,
        allowed_file_roots: [root],
        allowed_origins: [],
        target_id: inspector.targetId,
        runtime_kind: "node",
        approved: true,
        observation_ms: 10,
      },
    });
    expect(observedRuntime.isError).not.toBe(true);
    expect(observedRuntime.structuredContent).toMatchObject({
      result: {
        target: {
          target_id: inspector.targetId,
          runtime_kind: "node",
          runtime_kind_authority: "caller-declared-unverified",
        },
        scripts: {
          items: [
            expect.objectContaining({
              location: { kind: "file", file_path: entry },
            }),
          ],
        },
      },
    });
    const evidenceId = evidenceIdFrom(observedRuntime.structuredContent);
    expect(session.evidenceById(evidenceId)).toBeDefined();
    expect(inspector.commands.map(({ method }) => method)).toEqual([
      "Runtime.enable",
      "Debugger.enable",
    ]);
    const direct = await observeJavaScriptRuntime(
      new V8InspectorProvider(),
      authority.value,
      {
        inspector_endpoint: inspector.endpoint,
        allowed_file_roots: [root],
        allowed_origins: [],
        target_id: inspector.targetId,
        runtime_kind: "node",
        approved: true,
        observation_ms: 10,
        limits: {
          max_events: 10_000,
          max_scripts: 2_000,
          max_execution_contexts: 1_000,
          max_location_bytes: 16_384,
          max_total_metadata_bytes: 4_194_304,
        },
      },
    );
    expect(direct.ok).toBe(true);
    if (direct.ok) expect(evidenceId).toBe(direct.value.evidence_id);
  });
});

const evidenceIdFrom = (value: unknown): string => {
  if (typeof value !== "object" || value === null)
    throw new TypeError("Missing structured result");
  const evidenceId = Reflect.get(value, "evidence_id");
  if (typeof evidenceId !== "string")
    throw new TypeError("Missing Evidence ID");
  return evidenceId;
};
