import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cliCommands } from "../../../src/cli/commandRegistry.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";
import {
  CLI_COMMAND_REGISTRATIONS,
  CLI_REGISTRATION_ORDER,
  type CliCommandRegistrationId,
} from "../../../src/cli/cliCommandRegistrations.js";
import { createCliShell } from "../../../src/cli/cliShell.js";
import type { CliInstance } from "../../../src/cli/types.js";

import { createDirectAnalysis } from "../../../src/composition/directAnalysis.js";
import { PRODUCT_IDENTITY } from "../../../src/identity.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../support/workspace/workspaceFixture.js";
import {
  processTest,
  type TestProcesses,
} from "../../support/process/processFixture.js";
import { serveInProcessCli } from "../../support/cli/serveInProcessCli.js";

const ENVIRONMENT = { PATH: process.env.PATH };
const COMPLETE_CLI_IMPORT = "REA_TEST_CLI_ENTRY_RESOLVED";
const monitorCompleteCli = (recording?: Readonly<Record<string, string>>) =>
  `data:text/javascript,${encodeURIComponent(`
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
  const resolved = next(specifier, context);
  if (resolved.url.endsWith("/dist/cli-runtime/cli.js")) process.stderr.write(${JSON.stringify(`${COMPLETE_CLI_IMPORT}\n`)});
  return resolved;
}, load(url, context, next) {
  const recording = ${JSON.stringify(recording ?? null)};
  if (recording !== null && url.endsWith("/dist/recordedCliCommandRegistrations.js"))
    return { format: "module", shortCircuit: true, source: "export const RECORDED_CLI_COMMAND_REGISTRATIONS = " + JSON.stringify(recording) };
  return next(url, context);
} });`)}`;

const topLevelNames = (cli: CliInstance): readonly string[] =>
  cliCommands(cli).map(({ name }) => name);

const createRegistrarCli = async (
  id: CliCommandRegistrationId,
): Promise<CliInstance> => {
  const registration = CLI_COMMAND_REGISTRATIONS[id];
  return createCliShell({
    selectedEnvironment: ENVIRONMENT,
    registrations: [{ registration, module: await registration.load() }],
    createAnalysis: createDirectAnalysis,
  });
};

const help = async (cli: CliInstance, path: string) =>
  serveInProcessCli(cli, [...path.split(" "), "--help"]);

const recordedRegistrations = async (): Promise<Record<string, string>> => {
  const module = (await import(
    pathToFileURL(resolve("dist/recordedCliCommandRegistrations.js")).href
  )) as { RECORDED_CLI_COMMAND_REGISTRATIONS: Record<string, string> };
  return module.RECORDED_CLI_COMMAND_REGISTRATIONS;
};

describe("lazy CLI registration", () => {
  let recorded: Record<string, string> = {};
  let complete!: CliInstance;
  const registrars = new Map<CliCommandRegistrationId, CliInstance>();

  beforeAll(async () => {
    recorded = await recordedRegistrations();
    complete = createCli(ENVIRONMENT);
    for (const id of CLI_REGISTRATION_ORDER) {
      registrars.set(id, await createRegistrarCli(id));
    }
  });

  it("records every top-level command under the one registrar that defines it", () => {
    expect(Object.keys(recorded).sort()).toEqual(
      [...topLevelNames(complete)].sort(),
    );
    for (const id of CLI_REGISTRATION_ORDER) {
      const alone = registrars.get(id)!;
      expect(
        [...topLevelNames(alone)].sort(),
        `${id} registers what the recording assigns it`,
      ).toEqual(
        Object.entries(recorded)
          .filter(([, owner]) => owner === id)
          .map(([name]) => name)
          .sort(),
      );
    }
  });

  it("gives each command the same definition alone as in the complete CLI", async () => {
    for (const id of CLI_REGISTRATION_ORDER) {
      const alone = registrars.get(id)!;
      for (const path of topLevelNames(alone)) {
        const page = await help(alone, path);
        expect(page.exitCode, path).toBe(0);
        expect(page.stdout, path).toContain(`Usage: rea ${path}`);
        expect(page, path).toEqual(await help(complete, path));
      }
    }
  });
});

describe("lazy CLI execution", () => {
  let compileCacheRoot = "";
  let compileCache = "";

  beforeAll(async () => {
    compileCacheRoot = (
      await createTestWorkspace("rea-cli-lazy-compile-cache-")
    ).root;
    compileCache = join(compileCacheRoot, "node-compile");
  });

  afterAll(async () => {
    if (compileCacheRoot !== "") {
      await removeTestWorkspace(compileCacheRoot);
    }
  });

  processTest(
    "runs a recorded command without loading the complete CLI",
    async ({ processes }) => {
      const home = await createTestTempDirectory("rea-cli-lazy-home-");
      const run = (arguments_: readonly string[]) =>
        processes.run(
          process.execPath,
          [
            `--import=${monitorCompleteCli()}`,
            join("scripts", "rea.mjs"),
            ...arguments_,
          ],
          {
            env: {
              ...ENVIRONMENT,
              HOME: home,
              NODE_COMPILE_CACHE: compileCache,
            },
          },
        );
      const lazy = await run([
        "--format=json",
        "list-cutter-sessions",
        "--timings=false",
      ]);
      expect(lazy.exitCode, lazy.stderr).toBe(0);
      expect(JSON.parse(lazy.stdout)).toMatchObject({ sessions: [] });
      expect(lazy.stderr).not.toContain(COMPLETE_CLI_IMPORT);
      const version = await run(["--version"]);
      expect(version.exitCode, version.stderr).toBe(0);
      expect(version.stdout).toBe(`${PRODUCT_IDENTITY.packageVersion}\n`);
      expect(version.stderr).not.toContain(COMPLETE_CLI_IMPORT);
      const retired = await run(["doctor", "--mcp", "--json", "--full-output"]);
      expect(retired.exitCode, retired.stderr).toBe(1);
      expect(JSON.parse(retired.stdout)).toMatchObject({
        ok: false,
        error: { code: "MCP_MODE_REMOVED" },
        meta: {
          command: "doctor",
          cta: { commands: [{ command: "rea mcp" }] },
        },
      });
      expect(retired.stderr).not.toContain(COMPLETE_CLI_IMPORT);
    },
  );

  processTest(
    "falls back to the complete CLI when the recorded registrar is unavailable",
    async ({ processes }) => {
      const name = "list-cutter-sessions";
      const hook = monitorCompleteCli({ [name]: "removed-registrar" });
      const home = await createTestTempDirectory("rea-cli-stale-recording-");
      const result = await processes.run(
        process.execPath,
        [`--import=${hook}`, join("scripts", "rea.mjs"), name, "--json"],
        {
          env: { ...ENVIRONMENT, HOME: home, NODE_COMPILE_CACHE: compileCache },
        },
      );
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ sessions: [] });
      expect(result.stderr).toContain(COMPLETE_CLI_IMPORT);
    },
  );

  processTest(
    "rejects each registrar's command the same way in a fresh lazy process",
    async ({ processes }) => {
      // In-process comparisons share every module the complete CLI imported.
      // A fresh process loads only the selected registrar, so it exposes one
      // that relies on another module's import-time setup.
      const recorded = await recordedRegistrations();
      const firstNames = new Map<string, string>();
      for (const [name, id] of Object.entries(recorded))
        if (!firstNames.has(id)) firstNames.set(id, name);
      expect([...firstNames.keys()].sort()).toEqual(
        [...CLI_REGISTRATION_ORDER].sort(),
      );
      const home = await createTestTempDirectory("rea-cli-lazy-fresh-");
      const complete = createCli(ENVIRONMENT);
      // An unknown option is rejected before any command handler runs.
      const invocation = (name: string) => [
        name,
        "--rea-test-unknown-option",
        "--json",
      ];
      const names = [...firstNames.values()];
      const diagnostics = new Map<string, unknown>();
      const LAUNCHES = 4;
      for (let start = 0; start < names.length; start += LAUNCHES)
        await Promise.all(
          names.slice(start, start + LAUNCHES).map(async (name) => {
            const result = await processes.run(
              process.execPath,
              [
                `--import=${monitorCompleteCli()}`,
                join("scripts", "rea.mjs"),
                ...invocation(name),
              ],
              {
                env: {
                  ...ENVIRONMENT,
                  HOME: home,
                  NODE_COMPILE_CACHE: compileCache,
                },
              },
            );
            expect(result.exitCode, name).toBe(1);
            expect(result.stderr, name).not.toContain(COMPLETE_CLI_IMPORT);
            const diagnostic: unknown = JSON.parse(result.stdout);
            expect(diagnostic, name).toMatchObject({
              code: "UNKNOWN",
              message: expect.stringContaining("--rea-test-unknown-option"),
            });
            diagnostics.set(name, diagnostic);
          }),
        );
      // The in-process fixture restores shared process.exitCode after each call.
      for (const name of names) {
        const expected = await serveInProcessCli(complete, invocation(name));
        expect(expected.exitCode, name).toBe(1);
        expect(diagnostics.get(name), name).toEqual(
          JSON.parse(expected.stdout),
        );
      }
    },
  );
});

interface LazyDiscoveryCase {
  readonly label: string;
  readonly arguments: readonly string[];
  readonly assertOutput: (stdout: string) => void;
}

const assertScopedHelp = (stdout: string): void => {
  expect(stdout).toContain("Usage: rea list-cutter-sessions");
  expect(stdout).not.toContain("\nCommands:\n");
};

const assertRootHelp = (stdout: string): void => {
  expect(stdout).toContain("\nCommands:\n");
};

const llmsCommandRows = (stdout: string): readonly string[] =>
  stdout.split("\n").filter((line) => line.startsWith("| `rea "));

const KNOWN_COMMAND_DISCOVERY_CASES: readonly LazyDiscoveryCase[] = [
  {
    label: "--help",
    arguments: ["list-cutter-sessions", "--help"],
    assertOutput: assertScopedHelp,
  },
  {
    label: "-h",
    arguments: ["list-cutter-sessions", "-h"],
    assertOutput: assertScopedHelp,
  },
  {
    label: "--schema",
    arguments: ["list-cutter-sessions", "--schema", "--json"],
    assertOutput: (stdout) => {
      const schema = JSON.parse(stdout) as Record<string, unknown>;
      expect(schema).toMatchObject({
        options: { type: "object" },
        globals: { properties: { timings: { type: "boolean" } } },
      });
      expect(Object.keys(schema).sort()).toEqual(["globals", "options"]);
    },
  },
  {
    label: "--llms",
    arguments: ["list-cutter-sessions", "--llms"],
    assertOutput: (stdout) => {
      const rows = llmsCommandRows(stdout);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toContain("`rea list-cutter-sessions`");
    },
  },
  {
    label: "--llms-full",
    arguments: ["list-cutter-sessions", "--llms-full"],
    assertOutput: (stdout) => {
      const headings = stdout
        .split("\n")
        .filter((line) => line.startsWith("# rea "));
      expect(headings).toEqual(["# rea list-cutter-sessions"]);
    },
  },
];

const COMPLETE_CLI_DISCOVERY_CASES: readonly LazyDiscoveryCase[] = [
  {
    label: "root --help",
    arguments: ["--help"],
    assertOutput: assertRootHelp,
  },
  {
    label: "root --llms",
    arguments: ["--llms"],
    assertOutput: (stdout) => {
      expect(llmsCommandRows(stdout).length).toBeGreaterThan(1);
    },
  },
  {
    label: "unknown command --help",
    arguments: ["unknown-command-xyz", "--help"],
    assertOutput: assertRootHelp,
  },
  {
    label: "builtin completions --help",
    arguments: ["completions", "--help"],
    assertOutput: (stdout) => {
      expect(stdout).toContain("Usage: rea completions");
    },
  },
];

const runMonitoredDiscoveryCli = (
  processes: TestProcesses,
  cliArguments: readonly string[],
  options: { readonly home: string; readonly compileCache: string },
) =>
  processes.run(
    process.execPath,
    [
      `--import=${monitorCompleteCli()}`,
      join("scripts", "rea.mjs"),
      ...cliArguments,
    ],
    {
      env: {
        ...ENVIRONMENT,
        HOME: options.home,
        NODE_COMPILE_CACHE: options.compileCache,
      },
    },
  );

describe("lazy CLI discovery", () => {
  let compileCacheRoot = "";
  let compileCache = "";

  beforeAll(async () => {
    compileCacheRoot = (
      await createTestWorkspace("rea-cli-lazy-discovery-cache-")
    ).root;
    compileCache = join(compileCacheRoot, "node-compile");
  });

  afterAll(async () => {
    if (compileCacheRoot !== "") {
      await removeTestWorkspace(compileCacheRoot);
    }
  });

  processTest.for(KNOWN_COMMAND_DISCOVERY_CASES)(
    "loads only the target registrar for known-command $label",
    async ({ arguments: cliArguments, assertOutput }, { processes }) => {
      const home = await createTestTempDirectory("rea-cli-lazy-discovery-");
      const result = await runMonitoredDiscoveryCli(processes, cliArguments, {
        home,
        compileCache,
      });
      expect(result.exitCode, result.stderr).toBe(0);
      assertOutput(result.stdout);
      expect(result.stderr).not.toContain(COMPLETE_CLI_IMPORT);
    },
  );

  processTest.for(COMPLETE_CLI_DISCOVERY_CASES)(
    "loads the complete CLI for $label",
    async ({ arguments: cliArguments, assertOutput }, { processes }) => {
      const home = await createTestTempDirectory("rea-cli-complete-discovery-");
      const result = await runMonitoredDiscoveryCli(processes, cliArguments, {
        home,
        compileCache,
      });
      expect(result.exitCode, result.stderr).toBe(0);
      assertOutput(result.stdout);
      expect(result.stderr).toContain(COMPLETE_CLI_IMPORT);
    },
  );
});
