import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import { expect } from "vitest";
import { processTest } from "../../support/process/processFixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { windowsNativeArtifactFixture } from "../../fixtures/windowsNativeArtifact.js";
import {
  WINDOWS_NATIVE_SOURCE_FILES,
  computeWindowsNativeSourceSha256,
} from "../../../src/domain/windowsNativeArtifact.js";

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
      const { bytes, manifest } = windowsNativeArtifactFixture();
      await writeFile(join(artifactRoot, manifest.artifact), bytes);
      const manifestPath = join(artifactRoot, "manifest.json");
      await writeFile(manifestPath, JSON.stringify(manifest));
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

      const arm64 = windowsNativeArtifactFixture("arm64");
      await writeFile(join(artifactRoot, arm64.manifest.artifact), arm64.bytes);
      const unindexed = await run();
      expect(unindexed.exitCode).not.toBe(0);
      expect(unindexed.stderr).toContain("Unindexed Windows native artifact");

      const multiManifest = {
        ...arm64.manifest,
        artifacts: {
          x64: {
            artifact: manifest.artifact,
            artifactSha256: manifest.artifactSha256,
          },
          arm64: {
            artifact: arm64.manifest.artifact,
            artifactSha256: arm64.manifest.artifactSha256,
          },
        },
      };
      await writeFile(manifestPath, JSON.stringify(multiManifest));
      const validMulti = await run();
      expect(validMulti.exitCode, validMulti.stderr).toBe(0);
      expect(JSON.parse(validMulti.stdout)).toEqual({
        ok: true,
        ...multiManifest,
        artifactBytes: arm64.bytes.length,
      });

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

processTest(
  "requires sourceSha256 to match native sources and scripts/build-windows-native.mjs in a source checkout",
  async ({ processes }) => {
    const root = await createTestTempDirectory(
      "rea-native-artifact-source-verifier-",
    );
    await mkdir(join(root, "scripts"), { recursive: true });
    await copyFile(
      join(repository, "scripts/verify-windows-native-artifact.mjs"),
      join(root, "scripts/verify-windows-native-artifact.mjs"),
    );
    await copyModuleGraph(root, "scripts/lib/verifier-source-loader.mjs");
    await copyModuleGraph(root, "src/domain/windowsNativeArtifact.ts");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ type: "module", version: "1.0.0" }),
    );
    const sourceBytes: Record<string, Buffer> = {};
    for (const sourcePath of WINDOWS_NATIVE_SOURCE_FILES) {
      const bytes = await readFile(join(repository, sourcePath));
      sourceBytes[sourcePath] = bytes;
      const target = join(root, sourcePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
    const sourceDigest = computeWindowsNativeSourceSha256(sourceBytes);
    expect(sourceDigest.ok).toBe(true);
    if (!sourceDigest.ok) throw sourceDigest.error;

    const artifactRoot = join(root, "native/windows/build");
    await mkdir(artifactRoot, { recursive: true });
    const { bytes, manifest } = windowsNativeArtifactFixture();
    await writeFile(join(artifactRoot, manifest.artifact), bytes);
    const manifestPath = join(artifactRoot, "manifest.json");
    const run = () =>
      processes.run(
        process.execPath,
        [join(root, "scripts/verify-windows-native-artifact.mjs")],
        { cwd: root },
      );

    await writeFile(manifestPath, JSON.stringify(manifest));
    const missingSourceDigest = await run();
    expect(missingSourceDigest.exitCode).not.toBe(0);
    expect(missingSourceDigest.stderr).toContain("sourceSha256 does not match");

    await writeFile(
      manifestPath,
      JSON.stringify({ ...manifest, sourceSha256: sourceDigest.value }),
    );
    const matching = await run();
    expect(matching.exitCode, matching.stderr).toBe(0);

    const buildScript = sourceBytes["scripts/build-windows-native.mjs"];
    expect(buildScript).toBeDefined();
    if (buildScript === undefined) return;
    await writeFile(
      join(root, "scripts/build-windows-native.mjs"),
      Buffer.concat([buildScript, Buffer.from("\n// recipe changed\n")]),
    );
    const staleRecipe = await run();
    expect(staleRecipe.exitCode).not.toBe(0);
    expect(staleRecipe.stderr).toContain("scripts/build-windows-native.mjs");
  },
);
