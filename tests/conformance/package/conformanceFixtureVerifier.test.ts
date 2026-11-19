import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it, onTestFinished } from "vitest";

import { splitNmSymbolRecords } from "../../../scripts/lib/conformance-fixtures.mjs";
import { createVerifierCommands } from "../../../scripts/lib/verify-commands.mjs";
import { awaitAcknowledgement } from "../../fixtures/lifecycleAcknowledgement.js";
import { runningTestDeadline } from "../../support/runningTestDeadline.js";
import { waitFor } from "../../support/testWait.js";
import { removeTestWorkspace } from "../../support/workspace/workspaceFixture.js";

const digest = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const verifier = fileURLToPath(
  new URL("../../../scripts/verify-conformance-fixtures.mjs", import.meta.url),
);

const ownedFixture = async (prefix: string) => {
  const commands = await createVerifierCommands();
  let root: string | undefined;
  onTestFinished(async () => {
    await commands.close();
    if (root !== undefined) await removeTestWorkspace(root);
  });
  root = await realpath(await mkdtemp(join(await realpath(tmpdir()), prefix)));
  return { commands, root };
};

it.skipIf(process.platform !== "darwin" && process.platform !== "linux").each([
  { mode: "complete", marker: "REA_C_ENTRY" },
  { mode: "cancelled", marker: "REA_C_ENTRY" },
  { mode: "renamed", marker: "REA_C_ENTRY" },
  { mode: "wrong-prefix", marker: "REA_C_ENTRY" },
  { mode: "prefix-complete", marker: "REA_C_ENTRY" },
  { mode: "marker", marker: "REA_C_ENTRY" },
  { mode: "fragment", marker: "performAction:error:" },
])(
  "verifies compiler-produced fixture records: $mode / $marker",
  { tags: ["long-running"] },
  async ({ mode, marker }) => {
    const { commands, root } = await ownedFixture("rea-fixture-symbols-");
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
      await commands.exec(
        "cc",
        ["-c", join(sources, path), "-o", join(output, artifact)],
        { timeout: runningTestDeadline() },
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
    if (mode === "cancelled") {
      const helper = join(root, "file");
      const ready = join(root, "file-started");
      await writeFile(
        helper,
        `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.CONFORMANCE_FILE_STARTED, String(process.pid));
setTimeout(() => {}, 15_000);
`,
      );
      await chmod(helper, 0o755);
      const controller = new AbortController();
      const pending = commands.exec(
        process.execPath,
        [verifier, manifest, sources],
        {
          cwd: root,
          env: {
            ...process.env,
            PATH: [root, process.env.PATH ?? ""].join(delimiter),
            CONFORMANCE_FILE_STARTED: ready,
          },
          signal: controller.signal,
          timeout: runningTestDeadline(),
        },
      );
      await awaitAcknowledgement(
        waitFor(() => readFile(ready)),
        pending,
        "conformance file probe",
      );
      controller.abort();
      await expect(pending).rejects.toMatchObject({
        reason: "cancelled",
        cleanupFailure: null,
      });
      return;
    }
    const result = commands.exec(
      process.execPath,
      [verifier, manifest, sources],
      {
        cwd: root,
        timeout: runningTestDeadline(),
      },
    );
    if (!["complete", "fragment", "prefix-complete"].includes(mode))
      await expect(result).rejects.toMatchObject({
        code: 1,
        snapshot: {
          stderr: {
            text: expect.stringContaining(
              mode === "renamed"
                ? `missing symbol ${prefix}rea_version_entry`
                : mode === "wrong-prefix"
                  ? `expected 1 ${prefix}rea_inventory_ records, received 0`
                  : `missing string marker ${marker}`,
            ),
          },
        },
      });
    else {
      const completed = await result;
      expect(completed.stderr).toBe("");
      expect(JSON.parse(completed.stdout)).toMatchObject({ verified: 2 });
    }
  },
);

it.each([
  { schemaVersion: undefined, expectations: {} },
  { schemaVersion: 1, expectations: {} },
  { schemaVersion: 2, expectations: { strings: ["ambiguous"] } },
])("refuses retired manifest semantics: %j", async (legacy) => {
  const { commands, root } = await ownedFixture(
    "rea-fixture-manifest-version-",
  );
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
    commands.exec(process.execPath, [verifier, manifest, root], {
      cwd: root,
      timeout: runningTestDeadline(),
    }),
  ).rejects.toMatchObject({
    code: 1,
    snapshot: {
      stderr: {
        text: expect.stringContaining(
          legacy.schemaVersion === 2
            ? "Invalid conformance fixture string expectations"
            : "Unsupported conformance manifest",
        ),
      },
    },
  });
});

it("preserves a carriage return that belongs to an nm symbol name", () => {
  expect(splitNmSymbolRecords("rea_entry\r\nrea_inventory_0000\r\n")).toEqual([
    "rea_entry\r",
    "rea_inventory_0000\r",
  ]);
});

it("refuses a missing explicit source root even when a default exists", async () => {
  const { commands, root } = await ownedFixture("rea-fixture-source-root-");
  await mkdir(join(root, "tests", "conformance"), { recursive: true });
  const manifest = join(root, "manifest.json");
  await writeFile(manifest, "{}");
  const selected = join(root, "selected-sources");
  await expect(
    commands.exec(process.execPath, [verifier, manifest, selected], {
      cwd: root,
      timeout: 10_000,
    }),
  ).rejects.toMatchObject({
    code: 1,
    snapshot: {
      stderr: { text: expect.stringContaining(selected) },
    },
  });
});
