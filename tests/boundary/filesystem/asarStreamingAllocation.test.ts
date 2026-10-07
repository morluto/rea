import { createHash } from "node:crypto";
import { fstatSync, type Stats } from "node:fs";
import {
  open as openFile,
  lstat,
  mkdir,
  rm,
  readdir,
  writeFile,
  truncate,
} from "node:fs/promises";
import { join } from "node:path";
import { createPackageWithOptions } from "@electron/asar";
import { describe, expect, it } from "vitest";
import { scanArtifactInventory } from "../../../src/application/ArtifactInventory.js";
import { AsarArtifactReader } from "../../../src/artifacts/AsarArtifactReader.js";
import { hashReadable } from "../../../src/artifacts/ArtifactHash.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const memberBytes = 64 * 1024 * 1024;
const expectedSha256 = (): string => {
  const hash = createHash("sha256");
  const zeros = Buffer.alloc(64 * 1024);
  for (let written = 0; written < memberBytes; written += zeros.length)
    hash.update(zeros);
  return hash.digest("hex");
};

const descriptorDirectory =
  process.platform === "darwin" ? "/dev/fd" : "/proc/self/fd";

const matchingDescriptorCount = async (identity: Stats): Promise<number> => {
  const descriptors = await readdir(descriptorDirectory);
  return descriptors.filter((descriptor) => {
    if (!/^\d+$/u.test(descriptor)) return false;
    try {
      const observed = fstatSync(Number(descriptor));
      return observed.dev === identity.dev && observed.ino === identity.ino;
    } catch {
      return false;
    }
  }).length;
};

const waitForNoMatchingDescriptor = async (identity: Stats): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await matchingDescriptorCount(identity)) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(await matchingDescriptorCount(identity)).toBe(0);
};

describe("ASAR entry streaming", () => {
  it.skipIf(process.platform === "win32")(
    "closes a packed member handle when its unopened output stream is destroyed",
    async () => {
      const root = await createTestTempDirectory(
        "rea-asar-destroy-before-read-",
      );
      const source = join(root, "source");
      const archive = join(root, "fixture.asar");
      await mkdir(source);
      await writeFile(join(source, "small.js"), "module.exports = 1;\n");
      await createPackageWithOptions(source, archive, {});

      const identity = await lstat(archive);
      const probe = await openFile(archive, "r");
      expect(await matchingDescriptorCount(identity)).toBeGreaterThan(0);
      await probe.close();
      await waitForNoMatchingDescriptor(identity);
      const reader = new AsarArtifactReader(archive);

      try {
        const entries = [];
        for await (const entry of reader.entries()) {
          entries.push(entry);
        }
        const entry = entries.find(({ path }) => path === "small.js");
        if (entry === undefined) throw new Error("Expected packed ASAR member");
        expect(await matchingDescriptorCount(identity)).toBe(0);
        const output = await reader.open(entry);
        expect(await matchingDescriptorCount(identity)).toBeGreaterThan(0);
        const closed = new Promise<void>((resolve) =>
          output.once("close", resolve),
        );
        output.destroy();
        await closed;
        await waitForNoMatchingDescriptor(identity);
      } finally {
        await reader.close();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "closes a packed member handle when cancellation arrives during open",
    async () => {
      const root = await createTestTempDirectory("rea-asar-abort-during-stat-");
      const source = join(root, "source");
      const archive = join(root, "fixture.asar");
      await mkdir(source);
      await writeFile(join(source, "small.js"), "module.exports = 1;\n");
      await createPackageWithOptions(source, archive, {});

      const identity = await lstat(archive);
      const reader = new AsarArtifactReader(archive);

      try {
        const entries = [];
        for await (const entry of reader.entries()) entries.push(entry);
        const entry = entries.find(({ path }) => path === "small.js");
        if (entry === undefined) throw new Error("Expected packed ASAR member");
        const controller = new AbortController();
        const opening = reader.open(entry, controller.signal);
        controller.abort();
        await expect(opening).rejects.toMatchObject({ reason: "cancelled" });
        await waitForNoMatchingDescriptor(identity);
      } finally {
        await reader.close();
      }
    },
  );

  it("classifies a missing packed member container as an I/O failure", async () => {
    const root = await createTestTempDirectory("rea-asar-missing-member-");
    const source = join(root, "source");
    const archive = join(root, "fixture.asar");
    await mkdir(source);
    await writeFile(join(source, "small.js"), "module.exports = 1;\n");
    await createPackageWithOptions(source, archive, {});

    const reader = new AsarArtifactReader(archive);
    try {
      const entries = [];
      for await (const entry of reader.entries()) entries.push(entry);
      const entry = entries.find(({ path }) => path === "small.js");
      if (entry === undefined) throw new Error("Expected packed ASAR member");
      await rm(archive);
      await expect(reader.open(entry)).rejects.toMatchObject({
        reason: "io",
        cause: { code: "ENOENT" },
      });
    } finally {
      await reader.close();
    }
  });

  it("reports the observed digest when an unpacked member changes size", async () => {
    const root = await createTestTempDirectory(
      "rea-asar-unpacked-size-change-",
    );
    const source = join(root, "source");
    const archive = join(root, "fixture.asar");
    const original = join(source, "small.js");
    const changed = "changed();\n";
    await mkdir(source);
    await writeFile(original, "module.exports = 1;\n");
    await createPackageWithOptions(source, archive, { unpack: "small.js" });
    await writeFile(join(`${archive}.unpacked`, "small.js"), changed);

    await expect(scanArtifactInventory(archive)).rejects.toMatchObject({
      reason: "integrity",
      details: {
        logicalPath: "small.js",
        calculatedSha256: createHash("sha256").update(changed).digest("hex"),
        unpacked: true,
      },
    });
  });

  it.each([
    ["packed", {}],
    ["unpacked", { unpack: "large.bin" }],
  ] as const)(
    "opens a %s member without allocating its full contents",
    async (_kind, options) => {
      const root = await createTestTempDirectory("rea-asar-streaming-");
      const source = join(root, "source");
      const archive = join(root, "fixture.asar");
      const member = join(source, "large.bin");
      await mkdir(source);
      await writeFile(member, Buffer.alloc(0));
      await truncate(member, memberBytes);
      await createPackageWithOptions(source, archive, options);

      const reader = new AsarArtifactReader(archive);
      try {
        const entries = [];
        for await (const entry of reader.entries()) entries.push(entry);
        const entry = entries.find(({ path }) => path === "large.bin");
        if (entry === undefined) throw new Error("Expected large ASAR member");

        const before = process.memoryUsage().arrayBuffers;
        const stream = await reader.open(entry);
        const afterOpen = process.memoryUsage().arrayBuffers;
        const observed = await hashReadable(stream);
        const allocation = afterOpen - before;

        expect(allocation).toBeLessThan(memberBytes / 2);
        expect(observed).toMatchObject({
          sha256: expectedSha256(),
          bytes: memberBytes,
        });
      } finally {
        await reader.close();
      }
    },
    120_000,
  );
});
