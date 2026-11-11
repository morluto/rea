import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const digest = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const verifier = fileURLToPath(
  new URL("../../../scripts/verify-conformance-fixtures.mjs", import.meta.url),
);

it.skipIf(process.platform !== "darwin" && process.platform !== "linux").each([
  { mode: "complete", marker: "REA_C_ENTRY" },
  { mode: "renamed", marker: "REA_C_ENTRY" },
  { mode: "wrong-prefix", marker: "REA_C_ENTRY" },
  { mode: "prefix-complete", marker: "REA_C_ENTRY" },
  { mode: "marker", marker: "REA_C_ENTRY" },
  { mode: "marker", marker: "REA_VERSION_ONE" },
  { mode: "marker", marker: "reaProbeOne" },
  { mode: "marker", marker: "REA_SWIFT_EXECUTE" },
  { mode: "fragment", marker: "REAService" },
  { mode: "fragment", marker: "performAction:error:" },
])(
  "verifies compiler-produced fixture records: $mode / $marker",
  async ({ mode, marker }) => {
    const root = await createTestTempDirectory("rea-fixture-symbols-");
    const sources = join(root, "sources");
    const output = join(root, "output");
    await mkdir(sources);
    await mkdir(output);
    const fixtures = [];
    const prefix = process.platform === "darwin" ? "_" : "";
    for (const version of [1, 2]) {
      const name = `version-v${version}`;
      const path = `${name}.c`;
      const artifact = `${name}.o`;
      const suffix = mode === "renamed" ? "_renamed" : "";
      const literal =
        mode === "marker"
          ? `${marker}_renamed`
          : mode === "fragment"
            ? `embedded_${marker}_suffix`
            : marker;
      const counted = mode === "prefix-complete" ? "" : "unrelated_";
      const content = `int rea_version_entry${suffix}(void) { return ${version}; }\nint ${counted}rea_inventory_0000(void) { return 0; }\nconst char *marker = "${literal}";\n`;
      await writeFile(join(sources, path), content);
      await execute(
        "cc",
        ["-c", join(sources, path), "-o", join(output, artifact)],
        { timeout: 10_000 },
      );
      const bytes = await readFile(join(output, artifact));
      fixtures.push({
        name,
        artifact,
        artifactSha256: digest(bytes),
        sources: [{ path, sha256: digest(content) }],
        sourceSha256: digest(`${path}\0${digest(content)}\n`),
        expectations: {
          symbols: [`${prefix}rea_version_entry`],
          ...(mode === "fragment"
            ? { stringFragments: [marker] }
            : { stringMarkers: [marker] }),
          ...(mode === "wrong-prefix" || mode === "prefix-complete"
            ? { symbolPrefix: `${prefix}rea_inventory_`, symbolCount: 1 }
            : {}),
        },
      });
    }
    const manifest = join(output, "manifest.json");
    await writeFile(
      manifest,
      JSON.stringify({
        schemaVersion: 2,
        platform: process.platform,
        fixtures,
      }),
    );
    const result = execute(process.execPath, [verifier, manifest, sources], {
      cwd: root,
      timeout: 25_000,
    });
    if (!["complete", "fragment", "prefix-complete"].includes(mode))
      await expect(result).rejects.toMatchObject({
        code: 1,
        signal: null,
        stderr: expect.stringContaining(
          mode === "renamed"
            ? `missing symbol ${prefix}rea_version_entry`
            : mode === "wrong-prefix"
              ? `expected 1 ${prefix}rea_inventory_ records, received 0`
              : `missing string marker ${marker}`,
        ),
      });
    else {
      const completed = await result.then(
        (value) => ({
          code: 0,
          signal: null,
          stdout: value.stdout,
          stderr: value.stderr,
        }),
        (error: unknown) => {
          if (!(error instanceof Error)) throw error;
          const failed = error as Error & {
            code?: number | null;
            signal?: NodeJS.Signals | null;
            stdout?: string;
            stderr?: string;
          };
          return {
            code: failed.code ?? null,
            signal: failed.signal ?? null,
            stdout: failed.stdout ?? "",
            stderr: failed.stderr ?? "",
          };
        },
      );
      expect(completed).toMatchObject({
        code: 0,
        signal: null,
        stderr: "",
      });
      expect(JSON.parse(completed.stdout)).toMatchObject({ verified: 2 });
    }
  },
);

it.each([
  { schemaVersion: undefined, expectations: {} },
  { schemaVersion: 1, expectations: {} },
  { schemaVersion: 2, expectations: { strings: ["ambiguous"] } },
])("refuses retired manifest semantics: %j", async (legacy) => {
  const root = await createTestTempDirectory("rea-fixture-manifest-version-");
  const manifest = join(root, "manifest.json");
  await writeFile(
    manifest,
    JSON.stringify({
      schemaVersion: legacy.schemaVersion,
      platform: "linux",
      fixtures: [{ expectations: legacy.expectations }],
    }),
  );
  await expect(
    execute(process.execPath, [verifier, manifest, root], {
      cwd: root,
      timeout: 10_000,
    }),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining(
      legacy.schemaVersion === 2
        ? "Invalid conformance fixture string expectations"
        : "Unsupported conformance manifest",
    ),
  });
});
