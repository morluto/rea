import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import { expect } from "vitest";
import { processTest } from "../../support/process/processFixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { windowsNativeArtifactFixture } from "../../fixtures/windowsNativeArtifact.js";

const repository = fileURLToPath(new URL("../../..", import.meta.url));

/** Copy the selected entry's relative ESM graph; package dependencies stay absent. */
const copyModuleGraph = async (root: string, entry: string): Promise<void> => {
  const pending = [join(repository, entry)];
  const copied = new Set<string>();
  while (pending.length > 0) {
    const source = pending.pop();
    if (source === undefined || copied.has(source)) continue;
    copied.add(source);
    const output = join(root, relative(repository, source));
    const text = await readFile(source, "utf8");
    await mkdir(dirname(output), { recursive: true });
    await copyFile(source, output);
    for (const node of parse(text, {
      sourceType: "module",
      plugins: ["typescript"],
    }).program.body) {
      if (
        node.type !== "ImportDeclaration" &&
        node.type !== "ExportNamedDeclaration" &&
        node.type !== "ExportAllDeclaration"
      )
        continue;
      const specifier = node.source?.value;
      if (!specifier?.startsWith(".")) continue;
      let dependency = resolve(dirname(source), specifier);
      try {
        await access(dependency);
      } catch (cause) {
        if (
          cause instanceof Error &&
          "code" in cause &&
          cause.code === "ENOENT" &&
          dependency.endsWith(".js") &&
          source.endsWith(".ts")
        )
          dependency = dependency.slice(0, -3) + ".ts";
        else throw cause;
      }
      pending.push(dependency);
    }
  }
};

const delayImportFixture = () => {
  const { bytes: identity, manifest } = windowsNativeArtifactFixture();
  const optional = 88;
  const directory = optional + 112 + 13 * 8;
  const section = optional + 240;
  const descriptors = 512;
  const bytes = Buffer.alloc(descriptors + 192);
  identity.copy(bytes);
  bytes.writeUInt16LE(1, 70); // NumberOfSections
  bytes.writeUInt16LE(240, 84); // SizeOfOptionalHeader
  bytes.writeUInt32LE(16, optional + 108);
  bytes.writeUInt32LE(0x1000, directory);
  bytes.writeUInt32LE(64, directory + 4);
  bytes.writeUInt32LE(192, section + 8); // VirtualSize
  bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(192, section + 16); // SizeOfRawData
  bytes.writeUInt32LE(descriptors, section + 20);
  bytes.writeUInt32LE(0xc000_0040, section + 36);
  bytes.writeUInt32LE(1, descriptors);
  bytes.writeUInt32LE(0x10b0, descriptors + 4);
  bytes.writeUInt32LE(0x1080, descriptors + 12);
  bytes.writeUInt32LE(0x1040, descriptors + 16);
  bytes.writeBigUInt64LE(1n, descriptors + 64);
  bytes.writeBigUInt64LE(2n, descriptors + 72);
  bytes.writeBigUInt64LE(1n, descriptors + 128);
  bytes.writeBigUInt64LE(2n, descriptors + 136);
  return { bytes, manifest, directory, section, descriptors };
};

for (const mode of ["preinstall source", "packed source-free"]) {
  processTest(
    `verifies native artifact identity from ${mode} without installed dependencies`,
    async ({ processes }) => {
      const root = await createTestTempDirectory(
        "rea-native-artifact-verifier-",
      );
      await mkdir(join(root, "scripts"), { recursive: true });
      await copyFile(
        join(repository, "scripts/verify-windows-native-artifact.mjs"),
        join(root, "scripts/verify-windows-native-artifact.mjs"),
      );
      if (mode === "preinstall source")
        await copyModuleGraph(root, "scripts/lib/verifier-source-loader.mjs");
      await copyModuleGraph(
        root,
        mode === "preinstall source"
          ? "src/domain/windowsNativeArtifact.ts"
          : "dist/domain/windowsNativeArtifact.js",
      );
      await expect(access(join(root, "node_modules"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      if (mode === "packed source-free") {
        await expect(access(join(root, "src"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(
          access(join(root, "scripts/lib/verifier-source-loader.mjs")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ type: "module", version: "1.0.0" }),
      );
      const artifactRoot = join(root, "native/windows/build");
      await mkdir(artifactRoot, { recursive: true });
      const { bytes, manifest, directory, section, descriptors } =
        delayImportFixture();
      const manifestPath = join(artifactRoot, "manifest.json");
      const writeArtifact = async () => {
        manifest.artifactSha256 = createHash("sha256")
          .update(bytes)
          .digest("hex");
        await writeFile(join(artifactRoot, manifest.artifact), bytes);
        await writeFile(manifestPath, JSON.stringify(manifest));
      };
      await writeArtifact();
      const run = () =>
        processes.run(
          process.execPath,
          [join(root, "scripts/verify-windows-native-artifact.mjs")],
          { cwd: root },
        );
      const valid = await run();
      expect(valid.exitCode, valid.stderr).toBe(0);
      expect(JSON.parse(valid.stdout)).toEqual({
        ok: true,
        ...manifest,
        artifactBytes: bytes.length,
      });
      bytes.writeUInt32LE(32, directory + 4);
      await writeArtifact();
      expect((await run()).exitCode).toBe(0);

      bytes.writeUInt32LE(1, descriptors + 32);
      await writeArtifact();
      const unterminated = await run();
      expect(unterminated.exitCode).not.toBe(0);
      expect(unterminated.stderr).toContain(
        "unterminated delay-import directory",
      );
      bytes.writeUInt32LE(0, descriptors + 32);
      bytes.writeUInt32LE(64, directory + 4);

      // The first thunk remains mapped and writable in each refusal below.
      bytes.writeUInt32LE(136, section + 8);
      bytes.writeUInt32LE(136, section + 16);
      await writeArtifact();
      const unmappedTail = await run();
      expect(unmappedTail.exitCode).not.toBe(0);
      expect(unmappedTail.stderr).toContain("outside writable PE data");

      // A second mapping can hold later slots; its permissions matter too.
      const tailSection = section + 40;
      bytes.writeUInt16LE(2, 70);
      bytes.writeUInt32LE(56, tailSection + 8);
      bytes.writeUInt32LE(0x1088, tailSection + 12);
      bytes.writeUInt32LE(56, tailSection + 16);
      bytes.writeUInt32LE(descriptors + 136, tailSection + 20);
      bytes.writeUInt32LE(0x4000_0040, tailSection + 36);
      await writeArtifact();
      const readOnlyTail = await run();
      expect(readOnlyTail.exitCode).not.toBe(0);
      expect(readOnlyTail.stderr).toContain("outside writable PE data");
      // The loader reads a null terminator but does not patch that slot.
      bytes.writeBigUInt64LE(0n, descriptors + 72);
      bytes.writeBigUInt64LE(0n, descriptors + 136);
      await writeArtifact();
      const readOnlyTerminator = await run();
      expect(readOnlyTerminator.exitCode, readOnlyTerminator.stderr).toBe(0);
      bytes.writeBigUInt64LE(2n, descriptors + 72);
      bytes.writeBigUInt64LE(2n, descriptors + 136);

      bytes.writeUInt32LE(0xc000_0040, tailSection + 36);
      await writeArtifact();
      const writableTail = await run();
      expect(writableTail.exitCode, writableTail.stderr).toBe(0);
      // Import names can live in read-only data while every function slot
      // lives in a separate writable mapping.
      bytes.writeUInt32LE(0x4000_0040, section + 36);
      bytes.writeUInt32LE(0x1088, descriptors + 12);
      bytes.writeBigUInt64LE(1n, descriptors + 136);
      bytes.writeBigUInt64LE(2n, descriptors + 144);
      await writeArtifact();
      const readOnlyNames = await run();
      expect(readOnlyNames.exitCode, readOnlyNames.stderr).toBe(0);
      bytes.writeUInt32LE(0xc000_0040, section + 36);
      bytes.writeUInt32LE(0x1080, descriptors + 12);
      bytes.writeBigUInt64LE(2n, descriptors + 136);
      bytes.writeBigUInt64LE(0n, descriptors + 144);
      bytes.writeUInt16LE(1, 70);
      bytes.fill(0, tailSection, tailSection + 40);
      bytes.writeUInt32LE(192, section + 8);
      bytes.writeUInt32LE(192, section + 16);

      bytes.writeBigUInt64LE(3n, descriptors + 144);
      bytes.writeBigUInt64LE(4n, descriptors + 152);
      await writeArtifact();
      const unterminatedIat = await run();
      expect(unterminatedIat.exitCode).not.toBe(0);
      expect(unterminatedIat.stderr).toContain("outside writable PE data");
      bytes.writeBigUInt64LE(0n, descriptors + 144);
      bytes.writeBigUInt64LE(0n, descriptors + 152);

      bytes.writeBigUInt64LE(0n, descriptors + 136);
      await writeArtifact();
      const earlyNullIat = await run();
      expect(earlyNullIat.exitCode).not.toBe(0);
      expect(earlyNullIat.stderr).toContain("inconsistent with its name table");
      bytes.writeBigUInt64LE(2n, descriptors + 136);

      bytes.writeUInt32LE(0x4000_0040, section + 36);
      await writeArtifact();
      const readOnlyIat = await run();
      expect(readOnlyIat.exitCode).not.toBe(0);
      expect(readOnlyIat.stderr).toContain("outside writable PE data");

      bytes.fill(0, directory, directory + 8);
      await writeArtifact();
      const missingDirectory = await run();
      expect(missingDirectory.exitCode).not.toBe(0);
      expect(missingDirectory.stderr).toContain(
        "no valid delay-import directory",
      );

      await writeFile(
        manifestPath,
        JSON.stringify({ ...manifest, extra: true }),
      );
      const invalid = await run();
      expect(invalid.exitCode).not.toBe(0);
      expect(invalid.stderr).toContain("missing or unknown fields");
    },
  );
}

processTest.skipIf(process.platform !== "linux")(
  "repairs an invalid Node header cache with a verified download",
  async ({ processes }) => {
    const root = await createTestTempDirectory("rea-native-build-cache-");
    const entry = "scripts/build-windows-native.mjs";
    await copyModuleGraph(root, entry);
    await copyModuleGraph(root, "src/domain/windowsNativeArtifact.ts");
    await writeFile(join(root, "package.json"), '{"type":"module"}');

    const cache = join(root, ".cache", "rea-windows-native");
    const bin = join(root, "bin");
    await mkdir(cache, { recursive: true });
    await mkdir(bin);
    const name = "node-v22.19.0-headers.tar.gz";
    const archive = join(cache, name);
    const validBytes = "verified header archive fixture";
    const digest = createHash("sha256").update(validBytes).digest("hex");
    await writeFile(archive, "interrupted download");
    await writeFile(
      join(bin, "x86_64-w64-mingw32-g++"),
      "#!/bin/sh\nexit 0\n",
      {
        mode: 0o755,
      },
    );
    // Stop at extraction so this test needs neither a real tarball nor MinGW.
    await writeFile(
      join(bin, "tar"),
      '#!/bin/sh\nprintf "extraction received: " >&2\ncat "$2" >&2\nexit 1\n',
      { mode: 0o755 },
    );

    const preload = join(root, "registry-fixture.mjs");
    await writeFile(
      preload,
      `globalThis.fetch = async (url) => {
        if (url.endsWith("/SHASUMS256.txt")) return new Response(${JSON.stringify(`${digest}  ${name}\n`)});
        if (url.endsWith(${JSON.stringify(`/${name}`)})) return new Response(process.env.HEADER_DOWNLOAD);
        throw new Error("Unexpected fetch: " + url);
      };\n`,
    );
    const run = (download: string) =>
      processes.run(
        process.execPath,
        ["--import", preload, join(root, entry)],
        {
          cwd: root,
          env: {
            ...process.env,
            HOME: root,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            HEADER_DOWNLOAD: download,
          },
        },
      );

    const invalid = await run("bad upstream content");
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stderr).toContain("SHA-256 mismatch");
    expect(invalid.stderr).not.toContain("extraction received");
    expect(await readFile(archive, "utf8")).toBe("interrupted download");

    const repaired = await run(validBytes);
    expect(repaired.stderr).toContain(`extraction received: ${validBytes}`);
    expect(await readFile(archive, "utf8")).toBe(validBytes);

    const cached = await run("bad upstream content");
    expect(cached.stderr).toContain(`extraction received: ${validBytes}`);
  },
);
