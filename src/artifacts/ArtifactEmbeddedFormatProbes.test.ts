import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { withOwnedRegularFile } from "../filesystem/OwnedRegularFile.js";
import { ArtifactEmbeddedFormatProbes } from "./ArtifactEmbeddedFormatProbes.js";
import * as dotnetLayout from "./dotnet/DotnetBundle.js";
import { dotnetBundleFixture } from "./dotnet/DotnetBundle.fixture.js";
import { denoMachO } from "./deno/DenoStandalone.fixture.js";
import * as denoLocation from "./deno/DenoStandaloneLocation.js";
import * as pckLocation from "./GodotPckLocation.js";
import { resolveArtifactReaderLimits } from "../domain/artifactReaderLimits.js";
import { nodeSeaElf } from "./nodeSea/NodeSea.fixture.js";

it("readmits cached SEA recognition when the accepted policy changes", async () => {
  const path = join(
    await createTestTempDirectory("rea-probe-policy-"),
    "carrier",
  );
  await writeFile(path, nodeSeaElf({ fuse: "set", ownership: "section" }));
  await withOwnedRegularFile(path, {}, async (source) => {
    const original = new ArtifactEmbeddedFormatProbes(path, source);
    const location = await original.nodeSea();
    expect(location).toBeDefined();
    const lower = new ArtifactEmbeddedFormatProbes(
      path,
      source,
      undefined,
      original.completedFacts(),
      resolveArtifactReaderLimits({ node_sea: { blob_bytes: 1 } }),
    );
    await expect(lower.nodeSea()).rejects.toMatchObject({
      reason: "limit",
      readerLimit: {
        parameter: "artifact_limits.node_sea.blob_bytes",
        effective_value: 1,
      },
    });
    expect(Object.hasOwn(lower.completedFacts(), "nodeSea")).toBe(false);
    const restored = new ArtifactEmbeddedFormatProbes(
      path,
      source,
      undefined,
      lower.completedFacts(),
      resolveArtifactReaderLimits(),
    );
    expect(await restored.nodeSea()).toEqual(location);
    const recognitionLimited = new ArtifactEmbeddedFormatProbes(
      path,
      source,
      undefined,
      restored.completedFacts(),
      resolveArtifactReaderLimits({
        node_sea: { recognition_header_count: 1 },
      }),
    );
    await expect(recognitionLimited.nodeSea()).resolves.toBeUndefined();
    expect(Object.hasOwn(recognitionLimited.completedFacts(), "nodeSea")).toBe(
      false,
    );
    expect(
      recognitionLimited.completedFacts().nodeSeaRecognitionFailure,
    ).toMatchObject({
      readerLimit: {
        parameter: "artifact_limits.node_sea.recognition_header_count",
        effective_value: 1,
        required_value: 3,
      },
    });
    const recognitionRestored = new ArtifactEmbeddedFormatProbes(
      path,
      source,
      undefined,
      recognitionLimited.completedFacts(),
      resolveArtifactReaderLimits({
        node_sea: { recognition_header_count: 3 },
      }),
    );
    expect(await recognitionRestored.nodeSea()).toEqual(location);
    expect(
      recognitionRestored.completedFacts().nodeSeaRecognitionFailure,
    ).toBeUndefined();
  });
});

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
      expect(Object.hasOwn(facts, "denoStandalone")).toBe(false);
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

it("reuses a located .NET header only for the same source and honors cached cancellation", async () => {
  const root = await createTestTempDirectory("rea-dotnet-probe-facts-");
  const path = join(root, "host");
  const fixture = dotnetBundleFixture();
  await writeFile(path, fixture.bytes);
  const locate = vi.spyOn(dotnetLayout, "findDotnetBundleHeader");
  try {
    const facts = await withOwnedRegularFile(path, {}, async (source) => {
      const controller = new AbortController();
      const first = new ArtifactEmbeddedFormatProbes(
        path,
        source,
        controller.signal,
      );
      expect(
        Object.hasOwn(first.completedFacts(), "dotnetBundleHeaderOffset"),
      ).toBe(false);
      await expect(first.dotnetBundle()).resolves.toBe(fixture.headerOffset);
      const completed = first.completedFacts();
      const resumed = new ArtifactEmbeddedFormatProbes(
        path,
        source,
        controller.signal,
        completed,
      );
      await expect(resumed.dotnetBundle()).resolves.toBe(fixture.headerOffset);
      expect(locate).toHaveBeenCalledTimes(1);
      const reason = new Error("cancel cached .NET observation");
      controller.abort(reason);
      await expect(resumed.dotnetBundle()).rejects.toMatchObject({
        reason: "cancelled",
        cause: reason,
      });
      return completed;
    });
    await appendFile(path, "changed");
    await withOwnedRegularFile(path, {}, async (source) => {
      expect(
        () => new ArtifactEmbeddedFormatProbes(path, source, undefined, facts),
      ).toThrow("Root artifact changed before inventory");
    });
    expect(locate).toHaveBeenCalledTimes(1);
  } finally {
    locate.mockRestore();
  }
});

it("keeps a failed .NET probe unexamined before a successful absence observation", async () => {
  const root = await createTestTempDirectory("rea-dotnet-probe-retry-");
  const path = join(root, "plain");
  await writeFile(path, "plain bytes");
  const failure = new Error("injected marker read failure");
  const locate = vi
    .spyOn(dotnetLayout, "findDotnetBundleHeader")
    .mockRejectedValueOnce(failure);
  try {
    await withOwnedRegularFile(path, {}, async (source) => {
      const probes = new ArtifactEmbeddedFormatProbes(path, source);
      await expect(probes.dotnetBundle()).rejects.toBe(failure);
      expect(
        Object.hasOwn(probes.completedFacts(), "dotnetBundleHeaderOffset"),
      ).toBe(false);
      await expect(probes.dotnetBundle()).resolves.toBeUndefined();
      expect(probes.completedFacts().dotnetBundleHeaderOffset).toBeNull();
      expect(locate).toHaveBeenCalledTimes(2);
    });
  } finally {
    locate.mockRestore();
  }
});

it("caches a present Deno section and records examined absence", async () => {
  const root = await createTestTempDirectory("rea-deno-probe-facts-");
  const presentPath = join(root, "deno");
  const absentPath = join(root, "plain");
  await writeFile(presentPath, denoMachO());
  await writeFile(absentPath, "plain bytes without a Deno section");
  const locate = vi.spyOn(denoLocation, "locateDenoStandalone");
  try {
    await withOwnedRegularFile(presentPath, {}, async (source) => {
      const probes = new ArtifactEmbeddedFormatProbes(presentPath, source);
      expect(Object.hasOwn(probes.completedFacts(), "denoStandalone")).toBe(
        false,
      );
      const found = await probes.denoStandalone();
      expect(found.status).toBe("present");
      await expect(probes.denoStandalone()).resolves.toBe(found);
      expect(locate).toHaveBeenCalledTimes(1);
    });
    await withOwnedRegularFile(absentPath, {}, async (source) => {
      const probes = new ArtifactEmbeddedFormatProbes(absentPath, source);
      expect(Object.hasOwn(probes.completedFacts(), "denoStandalone")).toBe(
        false,
      );
      await expect(probes.denoStandalone()).resolves.toEqual({
        status: "absent",
      });
      expect(probes.completedFacts().denoStandalone).toEqual({
        status: "absent",
      });
    });
  } finally {
    locate.mockRestore();
  }
});
