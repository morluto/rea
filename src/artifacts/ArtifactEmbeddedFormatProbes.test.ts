import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { withOwnedRegularFile } from "../filesystem/OwnedRegularFile.js";
import { ArtifactEmbeddedFormatProbes } from "./ArtifactEmbeddedFormatProbes.js";
import * as pckLocation from "./GodotPckLocation.js";

it("distinguishes examined absence from unexamined formats and honors cancellation on a cached result", async () => {
  const root = await createTestTempDirectory("rea-embedded-probe-facts-");
  const path = join(root, "plain");
  await writeFile(path, "plain bytes without an embedded archive");
  const locate = vi.spyOn(pckLocation, "locateGodotPck");
  try {
    await withOwnedRegularFile(path, {}, async (source) => {
      const controller = new AbortController();
      const probes = new ArtifactEmbeddedFormatProbes(
        path,
        source,
        controller.signal,
      );
      await expect(probes.godotPck()).resolves.toBeUndefined();
      const facts = probes.completedFacts();
      expect(facts.godotPck).toBeNull();
      expect(Object.hasOwn(facts, "nodeSea")).toBe(false);
      expect(Object.hasOwn(facts, "pyInstaller")).toBe(false);
      const resumed = new ArtifactEmbeddedFormatProbes(
        path,
        source,
        controller.signal,
        facts,
      );
      await expect(resumed.godotPck()).resolves.toBeUndefined();
      expect(locate).toHaveBeenCalledTimes(1);
      const reason = new Error("cancel cached observation");
      controller.abort(reason);
      await expect(resumed.godotPck()).rejects.toMatchObject({
        reason: "cancelled",
        cause: reason,
      });
      expect(locate).toHaveBeenCalledTimes(1);
    });
  } finally {
    locate.mockRestore();
  }
});

it("leaves a failed probe unexamined so a subsequent successful observation can be retained", async () => {
  const root = await createTestTempDirectory("rea-embedded-probe-failure-");
  const path = join(root, "plain");
  await writeFile(path, "plain bytes without an embedded archive");
  const failure = Object.assign(new Error("injected read failure"), {
    code: "EIO",
  });
  const locate = vi
    .spyOn(pckLocation, "locateGodotPck")
    .mockRejectedValueOnce(failure);
  try {
    await withOwnedRegularFile(path, {}, async (source) => {
      const probes = new ArtifactEmbeddedFormatProbes(path, source);
      await expect(probes.godotPck()).rejects.toBe(failure);
      expect(Object.hasOwn(probes.completedFacts(), "godotPck")).toBe(false);
      await expect(probes.godotPck()).resolves.toBeUndefined();
      expect(probes.completedFacts().godotPck).toBeNull();
      expect(locate).toHaveBeenCalledTimes(2);
    });
  } finally {
    locate.mockRestore();
  }
});
