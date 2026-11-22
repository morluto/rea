import { expect, it } from "vitest";
import {
  controlledCleanup,
  phaseGate,
  settledCause,
} from "../../tests/support/lifecycleHarness.js";
import { ArtifactResourceScope } from "../resources/ArtifactResourceScope.js";
import { RegularFileCleanupFailure } from "../filesystem/OwnedRegularFile.js";
import { RetainedRegularFileCleanupFailure } from "../process/RegularFileRead.js";
import { MANAGED_SKILL_FILES } from "./SetupSkill.js";
import {
  readGuidanceSectionWithReader,
  searchGuidanceWithReader,
} from "./GuidanceAccess.js";

const content = (path: string) =>
  path === MANAGED_SKILL_FILES[0] ? "# needle\nInstructions\n" : "# Other\n";

it.each(["search", "read"] as const)(
  "finishes every guide in an admitted %s while shutdown waits",
  async (action) => {
    const resources = new ArtifactResourceScope();

    const secondRead = phaseGate();
    const paths: string[] = [];
    const reader = (path: string, admitted = resources) =>
      admitted.run(async () => {
        paths.push(path);
        if (path === MANAGED_SKILL_FILES[1]) await secondRead.hold();
        return content(path);
      });
    const launched: Promise<unknown>[] = [];
    try {
      const initial = await searchGuidanceWithReader(
        { query: "needle" },
        async (path) => content(path),
        resources,
      );
      if (!initial.ok || initial.value.status !== "matches")
        throw new Error("Expected match");
      const operation =
        action === "search"
          ? searchGuidanceWithReader({ query: "needle" }, reader, resources)
          : readGuidanceSectionWithReader(
              { locator: initial.value.matches[0]?.locator },
              reader,
              resources,
            );
      launched.push(operation);
      await secondRead.reached(operation, "second guidance read");
      let closed = false;
      const closing = resources.close().then(() => {
        closed = true;
      });
      launched.push(closing);
      await Promise.resolve();
      expect(closed).toBe(false);
      secondRead.release();
      expect(await operation).toMatchObject({
        ok: true,
        value: { status: action === "search" ? "matches" : "section" },
      });
      await closing;
      expect(paths).toEqual(MANAGED_SKILL_FILES);
      expect(closed).toBe(true);
      expect(resources.hasPending).toBe(false);
    } finally {
      secondRead.release();
      await Promise.allSettled(launched);
      await resources.close();
    }
  },
);

it("retains a failed child while another admitted request reaches later reads", async () => {
  const resources = new ArtifactResourceScope();
  const overlappingRead = phaseGate();
  const descriptor = controlledCleanup({
    refused: true,
    failure: new Error("close denied"),
  });
  const paths: string[] = [];
  const failure = new RetainedRegularFileCleanupFailure(
    new RegularFileCleanupFailure({
      path: "owned guidance descriptor",
      owner: { close: () => descriptor.close() } as never,
      outcome: { kind: "failed", cause: new Error("read failed") },
      cleanupCause: new Error("close denied"),
    }),
  );
  const launched: Promise<unknown>[] = [];
  try {
    const active = searchGuidanceWithReader(
      { query: "needle" },
      (path, child) =>
        child.run(async () => {
          paths.push(path);
          if (path === MANAGED_SKILL_FILES[1]) await overlappingRead.hold();
          return content(path);
        }),
      resources,
    );
    launched.push(active);
    await overlappingRead.reached(active, "overlapping guidance read");
    const failing = searchGuidanceWithReader(
      { query: "needle" },
      async (_path, child) => {
        child.retain(failure.cleanupOwner);
        throw failure;
      },
      resources,
    );
    launched.push(failing);
    const failed = await failing;
    if (failed.ok) throw new Error("Expected cleanup failure");
    expect(failed.error.cleanupResources).toEqual([
      "owned guidance descriptor",
    ]);
    expect(failed.error.cleanupIncomplete).toBe(true);
    const closing = settledCause(resources.close());
    launched.push(closing);
    overlappingRead.release();
    expect(await active).toMatchObject({
      ok: true,
      value: { status: "matches" },
    });
    expect(paths).toEqual(MANAGED_SKILL_FILES);
    expect(await closing).toMatchObject({
      cleanup: { resources: ["owned guidance descriptor"] },
    });
    expect(resources.hasPending).toBe(true);
    expect(failed.error.cleanupIncomplete).toBe(true);
    descriptor.allow();
    await resources.close();
    expect(resources.hasPending).toBe(false);
    expect(failed.error.cleanupIncomplete).toBe(false);
  } finally {
    overlappingRead.release();
    descriptor.allow();
    await Promise.allSettled(launched);
    await resources.close();
  }
});

it("refuses new work after shutdown without reporting a missing bundle", async () => {
  const resources = new ArtifactResourceScope();
  await resources.close();
  let reads = 0;
  await expect(
    searchGuidanceWithReader(
      { query: "needle" },
      async (path) => {
        reads += 1;
        return content(path);
      },
      resources,
    ),
  ).rejects.toMatchObject({ reason: "unavailable" });
  expect(reads).toBe(0);
});
