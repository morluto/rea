import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { processTest } from "../../support/process/processFixture.js";

processTest(
  "runs the caller-selected npm entry through Node without rewriting its inputs",
  async ({ processes }) => {
    const root = await createTestTempDirectory("rea-npm-invocation-");
    const npmEntry = join(root, "selected npm entry.mjs");
    const arguments_ = [
      "pack",
      "value with spaces",
      "--literal=$HOME",
      "quote'and\"double",
    ];
    await writeFile(
      npmEntry,
      `process.stdout.write(JSON.stringify({ arguments: process.argv.slice(2), cwd: process.cwd(), marker: process.env.REA_NPM_TEST_MARKER, ambient: process.env.REA_NPM_TEST_AMBIENT ?? null }));\n`,
    );
    const helper = pathToFileURL(
      resolve("scripts/lib/verify-package-commands.mjs"),
    ).href;
    const cleanup = pathToFileURL(
      resolve("scripts/lib/verifier-cleanup.mjs"),
    ).href;
    const program = `
      const { createPackageVerifierCommands } = await import(${JSON.stringify(helper)});
      const { withVerifierCleanup } = await import(${JSON.stringify(cleanup)});
      const commands = await createPackageVerifierCommands({
        workspace: { path: ${JSON.stringify(root)}, close: async () => {} },
      });
      process.env.REA_NPM_TEST_AMBIENT = "ambient-only";
      const result = await withVerifierCleanup(
        () => commands.execNpm(${JSON.stringify(arguments_)}, {
          cwd: ${JSON.stringify(root)},
          env: {
            ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
            npm_execpath: ${JSON.stringify(npmEntry)},
            REA_NPM_TEST_MARKER: "caller-selected",
          },
        }),
        [() => commands.close()],
      );
      process.stdout.write(result.stdout);
    `;
    const result = await processes.run(
      process.execPath,
      ["--input-type=module", "--eval", program],
      { windowsHide: true },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.signal, result.stderr).toBeNull();
    expect(JSON.parse(result.stdout)).toEqual({
      arguments: arguments_,
      cwd: root,
      marker: "caller-selected",
      ambient: null,
    });
  },
);

const windowsIt = processTest.skipIf(process.platform !== "win32");

windowsIt(
  "uses the npm entry adjacent to Node when none is selected",
  async ({ processes }) => {
    const root = await createTestTempDirectory("rea-adjacent-npm-");
    const node = join(root, "node.exe");
    const npmEntry = join(root, "node_modules/npm/bin/npm-cli.js");
    await mkdir(dirname(npmEntry), { recursive: true });
    await Promise.all([
      copyFile(process.execPath, node),
      writeFile(
        npmEntry,
        `process.stdout.write(JSON.stringify({ arguments: process.argv.slice(2), cwd: process.cwd() }));\n`,
      ),
    ]);
    const helper = pathToFileURL(
      resolve("scripts/lib/verify-package-commands.mjs"),
    ).href;
    const cleanup = pathToFileURL(
      resolve("scripts/lib/verifier-cleanup.mjs"),
    ).href;
    const program = `
      const { createPackageVerifierCommands } = await import(${JSON.stringify(helper)});
      const { withVerifierCleanup } = await import(${JSON.stringify(cleanup)});
      const commands = await createPackageVerifierCommands({
        workspace: { path: ${JSON.stringify(root)}, close: async () => {} },
      });
      const environment = { ...process.env };
      delete environment.npm_execpath;
      const result = await withVerifierCleanup(
        () => commands.execNpm(["pack", "value with spaces"], {
          cwd: ${JSON.stringify(root)},
          env: environment,
        }),
        [() => commands.close()],
      );
      process.stdout.write(result.stdout);
    `;
    const environment = { ...process.env };
    delete environment.npm_execpath;
    const result = await processes.run(
      node,
      ["--input-type=module", "--eval", program],
      { env: environment, windowsHide: true },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.signal, result.stderr).toBeNull();
    expect(JSON.parse(result.stdout)).toEqual({
      arguments: ["pack", "value with spaces"],
      cwd: root,
    });
  },
);
