import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";

import { elf } from "../../../src/domain/binaryTarget.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { writeFakeKuna } from "../providers/kuna/fakeKuna.js";

const FUNCTIONS = [
  { name: "main", addr: "0x1000" },
  { name: "parse", addr: "0x1040" },
  { name: "late", addr: "0x1080" },
] as const;

const createAppBundleWithFakeKuna = async (root: string) => {
  const bundle = join(root, "Example.app");
  await mkdir(join(bundle, "Contents", "MacOS"), { recursive: true });
  await writeFile(
    join(bundle, "Contents", "Info.plist"),
    "<plist><dict><key>CFBundleExecutable</key><string>Example</string></dict></plist>",
  );
  await writeFile(join(bundle, "Contents", "MacOS", "Example"), elf(2, 1, 62));
  const kuna = await writeFakeKuna(root, {
    functions: [{ name: "main", addr: "0x1000" }],
    inventoryImports: false,
  });
  return { bundle, kuna };
};

describe("decompile-all CLI", () => {
  cliTest(
    "rejects an empty target before resolving or exporting the working directory",
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-decompile-all-empty-");
      const { bundle, kuna } = await createAppBundleWithFakeKuna(root);
      const environment = {
        REA_LOG_LEVEL: "silent",
        REA_KUNA_COMMAND: kuna,
        REA_KUNA_CACHE_DIR: join(root, "cache"),
      };

      const empty = await cli.run({
        arguments: [
          "decompile-all",
          "",
          "--provider",
          "kuna",
          "--output",
          join(root, "empty-output"),
          "--json",
        ],
        cwd: bundle,
        environment,
      });
      expect(empty.exitCode).toBe(1);
      expect(empty.json).toMatchObject({
        code: "VALIDATION_ERROR",
        fieldErrors: expect.arrayContaining([
          expect.objectContaining({ path: "path", code: "too_small" }),
        ]),
      });
      await expect(readdir(join(root, "empty-output"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const explicit = await cli.run({
        arguments: [
          "decompile-all",
          ".",
          "--provider",
          "kuna",
          "--output",
          join(root, "dot-output"),
          "--json",
        ],
        cwd: bundle,
        environment,
      });
      expect(explicit.exitCode, JSON.stringify(explicit.json)).toBe(0);
      expect(await readdir(join(root, "dot-output", "functions"))).toEqual([
        "0x1000.c",
      ]);
    },
  );

  cliTest(
    "maps filters, limit and a relative output directory to the export",
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-decompile-all-cli-");
      const kuna = await writeFakeKuna(root, { functions: FUNCTIONS });
      const target = join(root, "target.elf");
      await writeFile(target, elf(2, 1, 62));
      const environment = {
        REA_LOG_LEVEL: "silent",
        REA_KUNA_COMMAND: kuna,
        REA_KUNA_CACHE_DIR: join(root, "cache"),
      };
      const result = await cli.run({
        arguments: [
          "decompile-all",
          target,
          "--provider",
          "kuna",
          "--output",
          "out",
          "--address-start",
          "0X1000",
          "--address-end",
          "0X1040",
          "--limit",
          "1",
          "--format",
          "json",
        ],
        cwd: root,
        environment,
      });
      expect(result.exitCode, JSON.stringify(result.json)).toBe(0);
      expect(result.json).toMatchObject({
        operation: "decompile_all",
        parameters: {
          output_directory: join(root, "out"),
          address_start: "0X1000",
          address_end: "0X1040",
          limit: 1,
          layout: "address",
          resume: false,
        },
        normalized_result: {
          output_directory: join(root, "out"),
          // The fake inventory also lists the import puts at 0x2000.
          counts: { selected: 2, excluded: 2, written: 1, remaining: 1 },
        },
      });
      expect(await readdir(join(root, "out", "functions"))).toEqual([
        "0x1000.c",
      ]);
      expect(JSON.stringify(result.json)).not.toContain(
        await readFile(join(root, "out", "functions", "0x1000.c"), "utf8"),
      );
      const resumed = await cli.run({
        arguments: [
          "decompile-all",
          target,
          "--provider",
          "kuna",
          "--output",
          "out",
          "--resume",
          "--address-start",
          "0X1000",
          "--address-end",
          "0X1040",
          "--limit",
          "100001",
          "--format",
          "json",
        ],
        cwd: root,
        environment,
      });
      expect(resumed.exitCode, JSON.stringify(resumed.json)).toBe(0);
      expect(resumed.json).toMatchObject({
        parameters: { limit: 100001, resume: true },
        normalized_result: {
          counts: { selected: 2, written: 1, skipped: 1, remaining: 0 },
        },
      });
    },
  );
});
