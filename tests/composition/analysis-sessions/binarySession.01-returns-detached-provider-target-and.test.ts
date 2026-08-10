import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import type {
  AnalysisProvider,
  CapabilityDescriptor,
} from "../../../src/application/AnalysisProvider.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { createInvestigationWorkspace } from "../../../src/domain/investigationWorkspace.js";
import { ok as resultOk } from "../../../src/domain/result.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";

const cacheProvider = (
  calls: string[],
  mayWriteFilesystem = false,
): AnalysisProvider => {
  const identity = {
    id: "fixture",
    name: "Fixture analysis provider",
    version: "1",
  } as const;
  return {
    identity: () => identity,
    resolveAnalysisProfile: () =>
      Promise.resolve(
        resultOk({
          profile: createAnalysisProfile(identity, 1, { fixture: true }),
          compatibility: {},
        }),
      ),
    capabilities: () => [
      cacheCapability(identity, "address_name", false, mayWriteFilesystem),
      cacheCapability(identity, "set_address_name", true),
    ],
    createClient: () => ({
      execute: (operation) => {
        calls.push(operation);
        return Promise.resolve(ok(operation));
      },
      close: () => Promise.resolve(),
    }),
  };
};

const cacheCapability = (
  provider: CapabilityDescriptor["provider"],
  operation: "address_name" | "set_address_name",
  mutatesArtifact: boolean,
  mayWriteFilesystem = false,
): CapabilityDescriptor => ({
  provider,
  operation,
  inputContractVersion: 1,
  outputContractVersion: 1,
  available: true,
  reason: null,
  pagination: "none",
  exhaustive: true,
  effects: {
    mutatesArtifact,
    launchesProcess: false,
    mayShowUi: false,
    mayAccessNetwork: false,
    mayWriteFilesystem,
    changesPermissions: false,
    requiresRoot: false,
  },
  limits: {
    maxResults: null,
    maxPayloadBytes: null,
    timeoutMs: null,
  },
  limitations: [],
});

const targets = async (): Promise<readonly [string, string]> => {
  const directory = await createTestTempDirectory("bb-session-");
  const first = join(directory, "first.hop");
  const second = join(directory, "second.hop");
  await writeFile(first, "one");
  await writeFile(second, "two");
  return [first, second];
};

describe("binary session", () => {
  it("returns detached provider, target, and workspace metadata", async () => {
    const [first] = await targets();
    const session = createTestBinarySession(cacheProvider([]));
    expect((await session.open(first)).ok).toBe(true);
    expect(session.status()).toMatchObject({
      analysis_run: {
        run_id: expect.any(String),
        process_lineage: { status: "not_observed" },
      },
    });
    expect(session.listUnknowns()).toEqual([]);
    const identity = session.providerIdentity();
    Reflect.set(identity, "id", "forged");
    expect(session.providerIdentity().id).toBe("fixture");

    const active = session.activeTarget();
    expect(active).toBeDefined();
    if (active !== undefined) Reflect.set(active, "path", "/tmp/forged");
    expect(session.activeTarget()?.path).toBe(first);

    const workspace = createInvestigationWorkspace(
      "Detached workspace",
      createEvidenceBundle([]),
      [],
    );
    expect(session.retainInvestigationWorkspace(workspace)).toBe("added");
    const direct = session.investigationWorkspace(workspace.workspace_id, 1);
    if (direct !== undefined) Reflect.set(direct, "revision", 999);
    const listed = session.investigationWorkspaces()[0];
    if (listed !== undefined) Reflect.set(listed, "workspace_id", "forged");
    expect(
      session.investigationWorkspace(workspace.workspace_id, 1),
    ).toMatchObject({ revision: 1, workspace_id: workspace.workspace_id });
    await session.close();
  });
});
