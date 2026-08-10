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
  it("replays exact immutable calls from a matching provider-neutral snapshot", async () => {
    const [first, second] = await targets();
    const initialCalls: string[] = [];
    const initial = createTestBinarySession(cacheProvider(initialCalls));
    expect((await initial.open(first)).ok).toBe(true);
    expect(
      (
        await initial.execute("address_name", {
          address: "0x1000",
          document: "first",
        })
      ).ok,
    ).toBe(true);
    const snapshot = initial.exportAnalysisSnapshot();
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.entries).toHaveLength(1);
    await initial.close();

    const replayCalls: string[] = [];
    const replay = createTestBinarySession(cacheProvider(replayCalls));
    expect(replay.importAnalysisSnapshot(snapshot.value)).toEqual({
      ok: true,
      value: 1,
    });
    expect((await replay.open(first)).ok).toBe(true);
    const cached = await replay.execute("address_name", {
      address: "0x1000",
      document: "first",
    });
    expect(cached.ok).toBe(true);
    if (cached.ok)
      expect(cached.value.limitations).toContainEqual(
        expect.stringContaining("local REA analysis snapshot"),
      );
    expect(
      (
        await replay.execute("set_address_name", {
          address: "0x1000",
          name: "renamed",
          document: "first",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await replay.execute("address_name", {
          address: "0x1000",
          document: "first",
        })
      ).ok,
    ).toBe(true);
    expect(replayCalls).toEqual(["health", "set_address_name", "address_name"]);
    expect(replay.exportAnalysisSnapshot().ok).toBe(false);
    expect((await replay.open(first)).ok).toBe(true);
    expect(replay.exportAnalysisSnapshot()).toMatchObject({
      ok: true,
      value: { entries: [{ operation: "address_name" }] },
    });
    await replay.close();

    const mismatch = createTestBinarySession(cacheProvider([]));
    expect(mismatch.importAnalysisSnapshot(snapshot.value).ok).toBe(true);
    const opened = await mismatch.open(second);
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error._tag).toBe("EvidenceIntegrityError");
    await mismatch.close();

    const profileMismatchCalls: string[] = [];
    const profileMismatchProvider = cacheProvider(profileMismatchCalls);
    const identity = profileMismatchProvider.identity();
    profileMismatchProvider.resolveAnalysisProfile = () =>
      Promise.resolve(
        resultOk({
          profile: createAnalysisProfile(
            {
              id: identity.id,
              name: identity.name,
              version: identity.version ?? "fixture-unresolved",
            },
            1,
            { fixture: "different-profile" },
          ),
          compatibility: {},
        }),
      );
    const profileMismatch = createTestBinarySession(profileMismatchProvider);
    expect(profileMismatch.importAnalysisSnapshot(snapshot.value).ok).toBe(
      true,
    );
    const profileOpened = await profileMismatch.open(first);
    expect(profileOpened.ok).toBe(false);
    if (!profileOpened.ok) {
      expect(profileOpened.error._tag).toBe("EvidenceIntegrityError");
      expect(profileOpened.error.message).toContain("profile_mismatch");
    }
    expect(profileMismatchCalls).toEqual([]);
    await profileMismatch.close();

    const activeProfileMismatch = createTestBinarySession(
      profileMismatchProvider,
    );
    expect((await activeProfileMismatch.open(first)).ok).toBe(true);
    const activeImport = activeProfileMismatch.importAnalysisSnapshot(
      snapshot.value,
    );
    expect(activeImport.ok).toBe(false);
    if (!activeImport.ok)
      expect(activeImport.error.message).toContain("profile_mismatch");
    await activeProfileMismatch.close();
  });

  it("does not snapshot reads that depend on the provider cursor", async () => {
    const [first] = await targets();
    const calls: string[] = [];
    const session = createTestBinarySession(cacheProvider(calls));
    expect((await session.open(first)).ok).toBe(true);
    expect((await session.execute("address_name", {})).ok).toBe(true);
    expect((await session.execute("address_name", {})).ok).toBe(true);
    expect(calls).toEqual(["health", "address_name", "address_name"]);
    expect(session.exportAnalysisSnapshot()).toMatchObject({
      ok: true,
      value: { entries: [] },
    });
    await session.close();
  });
});
