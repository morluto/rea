import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import { ArtifactProvider } from "../../../../src/artifacts/ArtifactProvider.js";
import { MachOSliceArtifactReader } from "../../../../src/artifacts/MachOSliceArtifactReader.js";
import { artifactInventoryInputSchema } from "../../../../src/contracts/artifactToolContracts.js";
import { artifactInventoryResultSchema } from "../../../../src/domain/artifactGraph.js";
import type { BinaryTarget } from "../../../../src/domain/binaryTarget.js";
import { ok } from "../../../../src/domain/result.js";
import type { NativeCommandRunner } from "../../../../src/native/CommandRunner.js";

describe("artifact pagination and slices", () => {
  it("paginates wide graphs without changing manifest identity", async () => {
    const root = await createTestTempDirectory("rea-wide-");
    await Promise.all(
      Array.from({ length: 520 }, async (_, index) =>
        writeFile(
          join(root, `file-${String(index).padStart(4, "0")}.txt`),
          `${index}`,
        ),
      ),
    );
    const client = new ArtifactProvider().createClient(
      target(root, "directory"),
    );
    const [first, secondPage] = await Promise.all([
      client.execute(
        "inventory_artifact",
        artifactInventoryInputSchema.parse({ occurrence_limit: 500 }),
      ),
      client.execute(
        "inventory_artifact",
        artifactInventoryInputSchema.parse({
          occurrence_offset: 500,
          occurrence_limit: 500,
        }),
      ),
    ]);
    expect(first.ok && secondPage.ok).toBe(true);
    if (!first.ok || !secondPage.ok) return;
    const left = artifactInventoryResultSchema.parse(first.value.result);
    const right = artifactInventoryResultSchema.parse(secondPage.value.result);
    expect(left.manifest).toEqual(right.manifest);
    expect(left.occurrences).toMatchObject({ total: 521, next_offset: 500 });
    expect(right.occurrences).toMatchObject({
      offset: 500,
      next_offset: null,
    });
  }, 15_000);

  it("uses bounded native lipo metadata for universal slice ranges", async () => {
    const root = await createTestTempDirectory("rea-slices-");
    const binary = join(root, "fat");
    await writeFile(binary, Buffer.from("0123456789abcdef"));
    const runner: NativeCommandRunner = {
      run: () =>
        Promise.resolve(
          ok({
            tool: "lipo",
            executable: "/usr/bin/lipo",
            executableSha256: "1".repeat(64),
            toolVersion: null,
            versionReason: "fixture",
            arguments: ["-detailed_info", binary],
            stdout:
              "architecture x86_64\n cputype 16777223\n cpusubtype 3\n offset 0\n size 8\n align 2^2\narchitecture arm64\n cputype 16777228\n cpusubtype 0\n offset 8\n size 8\n align 2^2\n",
            stderr: "",
            stdoutBytes: 1,
            stderrBytes: 0,
            stdoutTruncated: false,
            stderrTruncated: false,
            exitCode: 0,
            signal: null,
          }),
        ),
    };
    const reader = new MachOSliceArtifactReader(binary, runner);
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    expect(entries).toHaveLength(2);
    const secondEntry = entries[1];
    expect(secondEntry).toBeDefined();
    if (secondEntry === undefined) return;
    expect(secondEntry).toMatchObject({
      path: "slices/arm64",
      byteOffset: 8,
      declaredSize: 8,
    });
    const chunks: Buffer[] = [];
    const stream = await reader.open(secondEntry);
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("89abcdef");
    expect(reader.provenance()).toEqual([
      expect.objectContaining({ tool: "lipo", effects: ["read"] }),
    ]);
    const provenance = reader.provenance();
    if (provenance[0] !== undefined)
      Reflect.set(provenance[0], "tool", "forged");
    expect(reader.provenance()[0]?.tool).toBe("lipo");
  });
});

const target = (
  path: string,
  format: Extract<BinaryTarget, { kind: "archive" }>["format"] | "directory",
): BinaryTarget => ({
  path,
  sourcePath: path,
  sha256: "0".repeat(64),
  kind: "archive",
  format: format === "directory" ? "asar" : format,
});
