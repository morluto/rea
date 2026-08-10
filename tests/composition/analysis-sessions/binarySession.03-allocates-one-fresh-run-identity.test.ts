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
  it("allocates one fresh run identity per provider client lifetime", async () => {
    const [first, second] = await targets();
    const provider = cacheProvider([]);
    const createClient = provider.createClient.bind(provider);
    const runIds: string[] = [];
    provider.createClient = (target, profile, context) => {
      if (context === undefined)
        throw new Error("missing analysis run context");
      runIds.push(context.runId);
      return createClient(target, profile, context);
    };
    const session = createTestBinarySession(provider);

    expect((await session.open(first)).ok).toBe(true);
    expect((await session.open(first)).ok).toBe(true);
    expect((await session.open(second)).ok).toBe(true);

    expect(runIds).toHaveLength(2);
    expect(new Set(runIds).size).toBe(2);
    await session.close();
  });
});
