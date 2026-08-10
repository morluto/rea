import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import type { AnalysisProvider } from "../../../src/application/AnalysisProvider.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";

const targets = async (): Promise<readonly [string, string]> => {
  const directory = await createTestTempDirectory("bb-session-");
  const first = join(directory, "first.hop");
  const second = join(directory, "second.hop");
  await writeFile(first, "one");
  await writeFile(second, "two");
  return [first, second];
};

const nonHopperProvider = (operations: string[]): AnalysisProvider => {
  const provider: AnalysisProvider = {
    identity: () => ({ id: "fixture", name: "Fixture", version: "1" }),
    capabilities: () => [
      {
        provider: { id: "fixture", name: "Fixture", version: "1" },
        operation: "address_name",
        inputContractVersion: 1,
        outputContractVersion: 1,
        available: true,
        reason: null,
        pagination: "none",
        exhaustive: true,
        effects: {
          mutatesArtifact: false,
          launchesProcess: false,
          mayShowUi: false,
          mayAccessNetwork: false,
          mayWriteFilesystem: false,
          changesPermissions: false,
          requiresRoot: false,
        },
        limits: {
          maxResults: null,
          maxPayloadBytes: null,
          timeoutMs: null,
        },
        limitations: [],
      },
    ],
    createClient: (_target, _profile, context) => {
      if (context === undefined)
        throw new Error("missing analysis run context");
      return {
        execute: (operation) => {
          operations.push(operation);
          return Promise.resolve(ok(operation));
        },
        runtimeLineageSnapshots: () => [
          {
            provider: provider.identity(),
            observation: {
              status: "verified",
              observedAt: "2026-07-22T10:00:00.000Z",
              lineage: {
                schemaVersion: 1,
                runId: context.runId,
                launcherPid: 100,
                launcherParentPid: 1,
                processGroupId: 100,
                descendants: [
                  { pid: 101, parentPid: 100, processGroupId: 100 },
                ],
              },
            },
          },
        ],
        requestActivitySnapshots: () => [
          {
            provider: provider.identity(),
            active: {
              requestId: 7,
              operation: "analyze_function",
              elapsedMs: 31_000,
              timeoutMs: 30_000,
              callerState: "timed_out",
            },
            queuedRequests: 2,
          },
        ],
        close: () => Promise.resolve(),
      };
    },
  };
  return provider;
};

describe("binary session", () => {
  it("runs through a non-Hopper analysis provider", async () => {
    const [first] = await targets();
    const operations: string[] = [];
    const provider = nonHopperProvider(operations);
    const session = createTestBinarySession(provider);
    expect((await session.open(first)).ok).toBe(true);
    expect(await session.execute("address_name", {})).toEqual({
      ok: true,
      value: {
        result: "address_name",
        rawResult: "address_name",
        provider: {
          id: "fixture",
          name: "Fixture analysis provider",
          version: "1",
        },
        limitations: [],
        locations: [],
        subject: null,
      },
    });
    expect(provider.identity().id).toBe("fixture");
    expect(provider.capabilities()[0]?.operation).toBe("address_name");
    expect(session.status()).toMatchObject({
      provider: { id: "fixture", name: "Fixture", version: "1" },
      providers: [{ id: "fixture", name: "Fixture", version: "1" }],
      capabilities: [
        {
          operation: "address_name",
          available: true,
          reason: null,
          effects: {
            mutates_artifact: false,
            launches_process: false,
          },
        },
      ],
      analysis_run: {
        run_id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        ),
        process_lineage: {
          status: "snapshots",
          snapshots: [
            {
              provider: { id: "fixture", name: "Fixture", version: "1" },
              observation: {
                status: "verified",
                observed_at: "2026-07-22T10:00:00.000Z",
                schema_version: 1,
                launcher_pid: 100,
                launcher_parent_pid: 1,
                process_group_id: 100,
                descendants: [
                  { pid: 101, parent_pid: 100, process_group_id: 100 },
                ],
              },
            },
          ],
        },
      },
      analysis_activity: {
        status: "timed_out_busy",
        providers: [
          {
            provider: { id: "fixture", name: "Fixture", version: "1" },
            active: {
              request_id: 7,
              operation: "analyze_function",
              elapsed_ms: 31_000,
              timeout_ms: 30_000,
              caller_state: "timed_out",
            },
            queued_requests: 2,
          },
        ],
      },
    });
    expect(operations).toEqual(["health", "address_name"]);
    await session.close();
  });
});
