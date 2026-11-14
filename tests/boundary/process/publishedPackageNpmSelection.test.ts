import {
  copyFile,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { expect } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { processTest } from "../../support/process/processFixture.js";

// These prerequisites isolate npm selection from registry availability, MCP
// conformance and updater behavior, which have their own integration suites.
const updaterProgram = `
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
export async function runUpdate(previousVersion, host) {
  await writeFile(join(host.root, "package.json"), JSON.stringify({ version: "6.9.0" }));
  return { status: "updated", previousVersion, latestVersion: "6.9.0", installedVersion: "6.9.0", command: ["npm", "install", "rea-agents@6.9.0"] };
}
`;
const prerequisiteProgram = `
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
export const readNpmRelease = async () => ({ status: "published", taggedVersion: "6.9.0", stableVersion: "6.9.0" });
export const stableUpdateVersion = () => "6.9.0";
export const verifyInstalledCanaryPackage = async () => ({ controlled_protocol_prerequisite: true });
export async function installCanaryPackage(specifier, workspace) {
  const root = join(workspace, "controlled-updater");
  await mkdir(join(root, "dist/application"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(join(root, "dist/application/Update.js"), ${JSON.stringify(updaterProgram)});
  await writeFile(join(root, "dist/application/UpdateRuntime.js"), 'export const systemUpdateHost = root => ({ root });');
  return root;
}
`;

const npmProgram = (entry: string) => `#!${process.execPath}
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(process.env.REA_RELEASE_NPM_LOG, JSON.stringify({ entry: ${JSON.stringify(entry)}, arguments: args, cwd: process.cwd(), marker: process.env.REA_RELEASE_NPM_MARKER }) + "\\n");
if (args[0] === "view") process.stdout.write(JSON.stringify(["6.8.0"]));
else if (args[0] === "install") {
  const prefix = args[args.indexOf("--prefix") + 1];
  const root = join(prefix, "lib/node_modules/rea-agents");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "6.8.0" }));
  mkdirSync(join(prefix, "bin"), { recursive: true });
  writeFileSync(join(prefix, "bin/rea-agents"), ${JSON.stringify(`#!${process.execPath}
process.stdout.write("  update  Update REA\\n");
`)}, { mode: 0o700 });
} else if (args[0] === "root") process.stdout.write(join(process.env.npm_config_prefix, "lib/node_modules"));
else throw new Error("Unexpected npm invocation: " + JSON.stringify(args));
`;

const prepare = async () => {
  const root = await createTestTempDirectory("rea-published-npm-selection-");
  const controller = join(root, "controller with spaces");
  const bin = join(root, "bin");
  await mkdir(join(controller, "scripts"), { recursive: true });
  await mkdir(bin);
  await writeFile(join(controller, "package.json"), '{"type":"module"}');
  await copyFile(
    "scripts/verify-published-package.mjs",
    join(controller, "scripts/verify-published-package.mjs"),
  );
  await symlink(resolve("node_modules"), join(controller, "node_modules"));
  const prerequisites = join(root, "prerequisites.mjs");
  await writeFile(prerequisites, prerequisiteProgram);
  const replacements = new Map([
    ["./lib/release-package-canary.mjs", pathToFileURL(prerequisites).href],
    ["./ci/npm-release.mjs", pathToFileURL(prerequisites).href],
    ...[
      "verify-package-commands.mjs",
      "verifier-cleanup.mjs",
      "verifier-run.mjs",
    ].map(
      (name) =>
        [
          `./lib/${name}`,
          pathToFileURL(resolve("scripts/lib", name)).href,
        ] as const,
    ),
  ]);
  const hook = join(root, "selected-dependencies.mjs");
  await writeFile(
    hook,
    `import { registerHooks } from "node:module";
const selected = new Map(${JSON.stringify([...replacements])});
const owner = ${JSON.stringify(pathToFileURL(join(controller, "scripts/verify-published-package.mjs")).href)};
registerHooks({ resolve(specifier, context, next) {
  return next(context.parentURL === owner ? selected.get(specifier) ?? specifier : specifier, context);
} });
`,
  );
  const selectedNpm = join(root, "selected npm entry.mjs");
  await writeFile(selectedNpm, npmProgram("selected"));
  await writeFile(join(bin, "npm"), npmProgram("PATH"), { mode: 0o700 });
  return { root, controller, hook, selectedNpm, bin };
};

processTest.skipIf(process.platform === "win32").for([true, false])(
  "preserves npm selection for all published-update operations (explicit selection: %s)",
  async (selected, { processes }) => {
    const { root, controller, hook, selectedNpm, bin } = await prepare();
    const log = join(root, "npm-operations.jsonl");
    const env = {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      npm_execpath: selected ? selectedNpm : undefined,
      REA_RELEASE_NPM_LOG: log,
      REA_RELEASE_NPM_MARKER: "caller selection with spaces",
    };
    const result = await processes.run(
      process.execPath,
      ["--import", hook, "scripts/verify-published-package.mjs", "6.9.0"],
      { cwd: controller, env },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    const calls = z
      .array(
        z.object({
          entry: z.string(),
          arguments: z.array(z.string()),
          cwd: z.string(),
          marker: z.string(),
        }),
      )
      .parse(
        (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      );
    expect(calls).toHaveLength(3);
    expect(calls.map(({ entry }) => entry)).toEqual(
      Array(3).fill(selected ? "selected" : "PATH"),
    );
    expect(calls.map(({ marker }) => marker)).toEqual(
      Array(3).fill("caller selection with spaces"),
    );
    const workspace = calls[0]!.cwd;
    expect(calls.map(({ cwd }) => cwd)).toEqual([
      workspace,
      workspace,
      workspace,
    ]);
    expect(calls.map(({ arguments: args }) => args)).toEqual([
      ["view", "rea-agents", "versions", "--json"],
      [
        "install",
        "--global",
        "--ignore-scripts",
        "--prefix",
        join(workspace, "update-prefix"),
        "rea-agents@6.8.0",
      ],
      ["root", "--global"],
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      version: "6.9.0",
      update: {
        status: "updated",
        previousVersion: "6.8.0",
        installedVersion: "6.9.0",
      },
    });
  },
);
