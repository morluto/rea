import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Cli } from "incur";
import { describe, expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";
import {
  CLI_COMMAND_REGISTRATIONS,
  CLI_REGISTRATION_ORDER,
  type CliCommandRegistrationId,
} from "../../../src/cli/cliCommandRegistrations.js";
import { selectCliRegistration } from "../../../src/cli/cliLoader.js";
import { createCliShell } from "../../../src/cli/cliShell.js";
import type { CliInstance } from "../../../src/cli/types.js";
import { visitRegisteredCommands } from "../../../src/cli/visitRegisteredCommands.js";
import { createDirectAnalysis } from "../../../src/composition/directAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { processTest } from "../../support/process/processFixture.js";
import { serveInProcessCli } from "../../support/cli/serveInProcessCli.js";

const ENVIRONMENT = { PATH: process.env.PATH };

// Incur types its router key without vars, env, or globals; accept any CLI.
const registeredCommands: WeakMap<
  object,
  Map<string, unknown>
> = Cli.toCommands;

const topLevelNames = (cli: CliInstance): readonly string[] => [
  ...(registeredCommands.get(cli)?.keys() ?? []),
];

const commandPaths = (cli: CliInstance): readonly string[] => {
  const paths: string[] = [];
  visitRegisteredCommands(cli, (_command, path) => paths.push(path));
  return paths;
};

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
  it("records every top-level command under the one registrar that defines it", async () => {
    const recorded = await recordedRegistrations();
    const complete = createCli(ENVIRONMENT);
    expect(Object.keys(recorded).sort()).toEqual(
      [...topLevelNames(complete)].sort(),
    );
    for (const id of CLI_REGISTRATION_ORDER) {
      const alone = await createRegistrarCli(id);
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
    const complete = createCli(ENVIRONMENT);
    const completePaths = new Set(commandPaths(complete));
    const covered = new Set<string>();
    for (const id of CLI_REGISTRATION_ORDER) {
      const alone = await createRegistrarCli(id);
      for (const path of commandPaths(alone)) {
        expect(completePaths.has(path), path).toBe(true);
        covered.add(path);
        expect(await help(alone, path), path).toEqual(
          await help(complete, path),
        );
      }
    }
    expect(covered).toEqual(completePaths);
  });

  it("loads one registrar only for a recorded command that runs", () => {
    const recorded = { "inspect-go-binary": "go", setup: "setup" };
    const select = (
      arguments_: readonly string[],
      environment: NodeJS.ProcessEnv = {},
      record: Readonly<Record<string, string>> | null = recorded,
    ) => selectCliRegistration(arguments_, environment, record ?? undefined);

    expect(select(["inspect-go-binary", "a.out"])).toBe("go");
    expect(select(["inspect-go-binary", "a.out", "--json"])).toBe("go");
    expect(select(["--format", "json", "inspect-go-binary", "a.out"])).toBe(
      "go",
    );
    expect(select(["--timings", "setup", "--dry-run"])).toBe("setup");
    // Help, schemas, LLM manifests and builtins describe the whole catalog.
    for (const flag of ["--help", "-h", "--schema", "--llms", "--llms-full"])
      expect(select(["inspect-go-binary", flag]), flag).toBeUndefined();
    expect(select(["inspect-go-binary", "--mcp"])).toBeUndefined();
    expect(select([])).toBeUndefined();
    expect(select(["skills", "add"])).toBeUndefined();
    // An unknown name needs every command for "did you mean".
    expect(select(["inspect-go-binar"])).toBeUndefined();
    expect(select(["constructor"])).toBeUndefined();
    // Shell completion and a missing or stale recording use the complete CLI.
    expect(select(["inspect-go-binary"], { COMPLETE: "bash" })).toBeUndefined();
    expect(select(["inspect-go-binary"], {}, null)).toBeUndefined();
    expect(
      select(["inspect-go-binary"], {}, { "inspect-go-binary": "removed" }),
    ).toBeUndefined();
  });

  processTest(
    "runs a recorded command without loading the complete CLI",
    async ({ processes }) => {
      const marker = "REA_TEST_CLI_ENTRY_RESOLVED";
      // Report a resolution of the complete CLI entry without changing it.
      const hook = `data:text/javascript,${encodeURIComponent(`
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
  const resolved = next(specifier, context);
  if (resolved.url.endsWith("/dist/cli-runtime/cli.js")) process.stderr.write(${JSON.stringify(`${marker}\n`)});
  return resolved;
} });`)}`;
      const home = await createTestTempDirectory("rea-cli-lazy-home-");
      const run = (arguments_: readonly string[]) =>
        processes.run(
          process.execPath,
          [`--import=${hook}`, join("scripts", "rea.mjs"), ...arguments_],
          { env: { ...ENVIRONMENT, HOME: home } },
        );
      const lazy = await run(["list-cutter-sessions", "--json"]);
      expect(lazy.exitCode, lazy.stderr).toBe(0);
      expect(JSON.parse(lazy.stdout)).toMatchObject({ sessions: [] });
      expect(lazy.stderr).not.toContain(marker);
      const complete = await run(["list-cutter-sessions", "--help"]);
      expect(complete.exitCode, complete.stderr).toBe(0);
      expect(complete.stderr).toContain(marker);
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
      // The one-shot host writes compact JSON; compare the documents.
      const document = (stdout: string): unknown => {
        try {
          return JSON.parse(stdout);
        } catch {
          return stdout;
        }
      };
      const lazy = new Map<string, { document: unknown; exitCode: number }>();
      const LAUNCHES = 4;
      for (let start = 0; start < names.length; start += LAUNCHES)
        await Promise.all(
          names.slice(start, start + LAUNCHES).map(async (name) => {
            const result = await processes.run(
              process.execPath,
              [join("scripts", "rea.mjs"), ...invocation(name)],
              { env: { ...ENVIRONMENT, HOME: home } },
            );
            lazy.set(name, {
              document: document(result.stdout),
              exitCode: result.exitCode ?? -1,
            });
          }),
        );
      for (const name of names) {
        const expected = await serveInProcessCli(complete, invocation(name));
        expect(lazy.get(name), name).toEqual({
          document: document(expected.stdout),
          exitCode: expected.exitCode,
        });
      }
    },
  );
});
