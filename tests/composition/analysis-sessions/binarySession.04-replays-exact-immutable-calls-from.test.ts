import { describe, expect, it } from "vitest";

import {
  createBinarySessionTargets,
  createCacheProvider,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import { ok as resultOk } from "../../../src/domain/result.js";

describe("binary session", () => {
  it("replays exact immutable calls from a matching provider-neutral snapshot", async () => {
    const [first, second] = await createBinarySessionTargets();
    const initialCalls: string[] = [];
    const initial = createTestBinarySession(createCacheProvider(initialCalls));
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
    const replay = createTestBinarySession(createCacheProvider(replayCalls));
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

    const mismatch = createTestBinarySession(createCacheProvider([]));
    expect(mismatch.importAnalysisSnapshot(snapshot.value).ok).toBe(true);
    const opened = await mismatch.open(second);
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error._tag).toBe("EvidenceIntegrityError");
    await mismatch.close();

    const profileMismatchCalls: string[] = [];
    const profileMismatchProvider = createCacheProvider(profileMismatchCalls);
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
    const [first] = await createBinarySessionTargets();
    const calls: string[] = [];
    const session = createTestBinarySession(createCacheProvider(calls));
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
