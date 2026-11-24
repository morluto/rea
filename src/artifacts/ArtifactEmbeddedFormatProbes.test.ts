import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { withOwnedRegularFile } from "../filesystem/OwnedRegularFile.js";
import { ArtifactEmbeddedFormatProbes } from "./ArtifactEmbeddedFormatProbes.js";
import { classifyEmbeddedExecutablePackage } from "./inventory/classify.js";
import * as bunLayout from "./bun/BunModuleGraphLayout.js";
import { artifactReaderLimitFailure } from "../resources/index.js";
import * as dotnetLayout from "./dotnet/DotnetBundle.js";
import { dotnetBundleFixture } from "./dotnet/DotnetBundle.fixture.js";
import { denoMachO } from "./deno/DenoStandalone.fixture.js";
import * as denoLocation from "./deno/DenoStandaloneLocation.js";
import * as pckLocation from "./GodotPckLocation.js";
import { resolveArtifactReaderLimits } from "../domain/artifactReaderLimits.js";
import { nodeSeaElf } from "./nodeSea/NodeSea.fixture.js";
import * as nodeSeaLocation from "./nodeSea/NodeSeaLocation.js";

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
    await expect(lower.nodeSea()).resolves.toBeUndefined();
    expect(Object.hasOwn(lower.completedFacts(), "nodeSea")).toBe(false);
    expect(lower.completedFacts().nodeSeaRecognitionFailure).toMatchObject({
      reason: "limit",
      readerLimit: {
        parameter: "artifact_limits.node_sea.blob_bytes",
        effective_value: 1,
      },
    });
    const restored = new ArtifactEmbeddedFormatProbes(
      path,
      source,
      undefined,
      lower.completedFacts(),
      resolveArtifactReaderLimits(),
    );
    expect(await restored.nodeSea()).toEqual(location);
    expect(restored.completedFacts().nodeSeaRecognitionFailure).toBeUndefined();
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
      ).toThrow(
        expect.objectContaining({
          reason: "integrity",
          integrityCheck: "container-identity",
        }),
      );
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

it("propagates I/O and cancellation errors from nodeSea without caching absence or recognition failure", async () => {
  const path = join(
    await createTestTempDirectory("rea-sea-probe-errors-"),
    "carrier",
  );
  await writeFile(path, nodeSeaElf({ fuse: "set", ownership: "section" }));
  const ioError = Object.assign(new Error("injected SEA read failure"), {
    code: "EIO",
  });
  const locate = vi
    .spyOn(nodeSeaLocation, "locateNodeSea")
    .mockRejectedValueOnce(ioError);
  try {
    await withOwnedRegularFile(path, {}, async (source) => {
      const probes = new ArtifactEmbeddedFormatProbes(path, source);
      await expect(probes.nodeSea()).rejects.toBe(ioError);
      expect(Object.hasOwn(probes.completedFacts(), "nodeSea")).toBe(false);
      expect(probes.completedFacts().nodeSeaRecognitionFailure).toBeUndefined();

      const controller = new AbortController();
      const cancelled = new ArtifactEmbeddedFormatProbes(
        path,
        source,
        controller.signal,
      );
      const reason = new Error("cancel SEA probe");
      controller.abort(reason);
      await expect(cancelled.nodeSea()).rejects.toMatchObject({
        reason: "cancelled",
        cause: reason,
      });
    });
  } finally {
    locate.mockRestore();
  }
});

it("reports unknown rather than absent from classifyEmbeddedExecutablePackage when Node SEA or Bun recognition is limited", async () => {
  const root = await createTestTempDirectory("rea-embedded-classify-unknown-");
  const seaPath = join(root, "sea-carrier");
  await writeFile(seaPath, nodeSeaElf({ fuse: "set", ownership: "section" }));
  await withOwnedRegularFile(seaPath, {}, async (source) => {
    const seaLimited = new ArtifactEmbeddedFormatProbes(
      seaPath,
      source,
      undefined,
      undefined,
      resolveArtifactReaderLimits({ node_sea: { blob_bytes: 1 } }),
    );
    await expect(
      classifyEmbeddedExecutablePackage(seaLimited, "elf"),
    ).resolves.toEqual({
      status: "unknown",
      limitations: [
        expect.stringMatching(/Node SEA recognition remains unknown/iu),
      ],
    });
  });

  const plainPath = join(root, "plain-elf");
  await writeFile(
    plainPath,
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, ...new Uint8Array(60)]),
  );
  const bunFailure = artifactReaderLimitFailure(
    "artifact_limits.bun.recognition_table_bytes",
    64,
    "bytes",
    128,
    "memory",
  );
  const bunSpy = vi
    .spyOn(bunLayout, "probeBunStandaloneGraph")
    .mockResolvedValueOnce({ status: "limited", failure: bunFailure });
  try {
    await withOwnedRegularFile(plainPath, {}, async (source) => {
      const bunLimited = new ArtifactEmbeddedFormatProbes(plainPath, source);
      await expect(
        classifyEmbeddedExecutablePackage(bunLimited, "elf"),
      ).resolves.toEqual({
        status: "unknown",
        limitations: [
          expect.stringMatching(/Bun graph recognition remains unknown/iu),
        ],
      });

      const plain = new ArtifactEmbeddedFormatProbes(plainPath, source);
      await expect(
        classifyEmbeddedExecutablePackage(plain, "elf"),
      ).resolves.toEqual({ status: "absent" });
    });
  } finally {
    bunSpy.mockRestore();
  }
});
