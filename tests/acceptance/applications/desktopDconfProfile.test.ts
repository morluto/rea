import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { expect, it } from "vitest";
import { cliTest } from "../../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  capture,
  checkpoint,
  HOME,
  retained,
  writeCaptureFolder,
} from "../../../src/application/desktop/desktopCapture.fixture.js";
import { desktopApplicationStateSchema } from "../../../src/domain/desktop/desktopState.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import {
  PYTHON_HELPERS,
  PYTHON_IMPORTS,
} from "../../../src/domain/desktop/appExportPython.js";
import {
  execFileOutput,
  execFileOutputFailure,
} from "../../../src/process/ExecFileOutput.js";

const available = (command: string, args: string[]) => {
  try {
    execFileSync(command, args, { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
};
// The real provider is optional, as in the other external-tool conformance cases.
const hasDconf = process.platform !== "win32" && available("dconf", ["help"]);
const hasPython = available("python3", ["-I", "-c", "import sqlite3"]);
const python = hasPython
  ? execFileSync("python3", ["-I", "-c", "import sys; print(sys.executable)"], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim()
  : "python3";
const dconf =
  hasDconf && hasPython
    ? execFileSync(
        python,
        ["-I", "-c", "import shutil; print(shutil.which('dconf'))"],
        { encoding: "utf8", timeout: 5_000 },
      ).trim()
    : "dconf";
const original = "[org/notes]\ncaptured=true\nkept=true\n";
const runDconf = (
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) =>
  execFileOutput(dconf, args, {
    ...options,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });

const databaseAt = async (directory: string) => {
  const keyfiles = join(directory, "keyfiles");
  await mkdir(keyfiles, { recursive: true });
  await writeFile(join(keyfiles, "source.ini"), original);
  const path = join(directory, "user");
  await runDconf(["compile", path, keyfiles]);
  return { path, bytes: await readFile(path) };
};

for (const name of ["ordinary", "hash#directory", "line\nbreak"]) {
  cliTest.skipIf(!hasDconf)(
    `real dconf retains the selected capture's settings under ${JSON.stringify(name)}`,
    async ({ cli }) => {
      const root = await createTestTempDirectory("dconf-capture-profile-");
      const temporary = join(root, name);
      await mkdir(temporary);
      const database = await databaseAt(join(root, "source"));
      const path = `${HOME}/.config/dconf/user`;
      const base = capture();
      const folder = await writeCaptureFolder(
        {
          ...base,
          state: {
            ...base.state,
            content_roots: [path],
            checkpoints: [
              checkpoint(
                "baseline",
                "baseline",
                [],
                [retained(path, database.bytes)],
              ),
            ],
          },
        },
        undefined,
        [database.bytes],
      );
      const result = await cli.run({
        arguments: ["inspect-desktop-application-state", folder, "--json"],
        environment: {
          PATH: process.env.PATH,
          TMPDIR: temporary,
          TMP: temporary,
          TEMP: temporary,
          REA_DCONF_COMMAND: "dconf",
        },
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const evidence = parseEvidence(result.json);
      const state = desktopApplicationStateSchema.parse(
        evidence.normalized_result,
      );
      expect(state.paths).toEqual([
        expect.objectContaining({
          home_path: ".config/dconf/user",
          versions: [
            expect.objectContaining({
              view: {
                groups: { "org/notes": { captured: "true", kept: "true" } },
                other_groups: [],
              },
              view_error: null,
            }),
          ],
        }),
      ]);
      expect((await readFile(database.path)).equals(database.bytes)).toBe(true);
    },
  );

  it.skipIf(!hasDconf || !hasPython)(
    `real exported dconf merge retains unrelated existing keys under ${JSON.stringify(name)}`,
    async () => {
      const root = await createTestTempDirectory("dconf-export-profile-");
      const home = join(root, name);
      const database = await databaseAt(join(home, ".config", "dconf"));
      const helper = join(root, "exported.py");
      await writeFile(
        helper,
        [
          ...PYTHON_IMPORTS.split("\n").filter(
            (line) => !line.includes("agentenv_protocol"),
          ),
          PYTHON_HELPERS,
          'SEED_HOME = "/home/captured"',
          'DCONF = "[org/notes]\\ncaptured=false\\n"',
          "_load_dconf(Path(sys.argv[1]))",
        ].join("\n"),
      );
      const verification = join(root, "verification-profile");
      await writeFile(verification, "file-db:./user\n");
      for (let replay = 0; replay < 2; replay += 1) {
        const result = await execFileOutput(python, ["-I", helper, home], {
          timeout: 10_000,
          maxBuffer: 64 * 1024,
          ...(name === "ordinary"
            ? { env: { PATH: relative(process.cwd(), dirname(dconf)) } }
            : {}),
        });
        expect(result.stderr).toBe("");
        const { stdout } = await runDconf(["dump", "/"], {
          cwd: dirname(database.path),
          env: { PATH: process.env.PATH, DCONF_PROFILE: verification },
        });
        expect(stdout).toBe("[org/notes]\ncaptured=false\nkept=true\n");
      }
    },
  );
}

// A command-lookup boundary, independent of the optional system dconf provider.
for (const searchPath of ["tools", "", "denied:tools", "denied"]) {
  cliTest.skipIf(process.platform === "win32" || !hasPython)(
    `capture and exported helper preserve ${JSON.stringify(searchPath)} PATH from a colon-containing cwd`,
    async ({ cli }) => {
      const root = await createTestTempDirectory("dconf-command-selection-");
      const cwd = join(root, "launch:split");
      const selected = searchPath === "" ? cwd : join(cwd, "tools");
      const denied = join(cwd, "denied");
      const foreign = join(root, "launch");
      const staged = join(root, "staged");
      await Promise.all([
        mkdir(selected, { recursive: true }),
        mkdir(denied, { recursive: true }),
        mkdir(foreign),
        mkdir(staged),
      ]);
      await writeFile(
        join(selected, "dconf"),
        `#!/bin/sh
[ "$PATH" = '${searchPath}' ] || exit 19
printf '[org/notes]\\nselected=true\\n'
`,
        { mode: 0o755 },
      );
      await writeFile(
        join(foreign, "dconf"),
        "#!/bin/sh\nprintf '[org/notes]\\nforeign=true\\n'\n",
        { mode: 0o755 },
      );
      await writeFile(join(denied, "dconf"), "#!/bin/sh\nexit 18\n", {
        mode: 0o600,
      });
      const path = `${HOME}/.config/dconf/user`;
      const bytes = Buffer.from("GVariant");
      const base = capture();
      const folder = await writeCaptureFolder(
        {
          ...base,
          state: {
            ...base.state,
            content_roots: [path],
            checkpoints: [
              checkpoint("baseline", "baseline", [], [retained(path, bytes)]),
            ],
          },
        },
        undefined,
        [bytes],
      );
      const result = await cli.run({
        arguments: ["inspect-desktop-application-state", folder, "--json"],
        cwd,
        environment: { PATH: searchPath, REA_DCONF_COMMAND: "dconf" },
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const state = desktopApplicationStateSchema.parse(
        parseEvidence(result.json).normalized_result,
      );
      if (searchPath === "denied") {
        expect
          .soft(state.paths[0]?.versions[0]?.view_error)
          .toContain("EACCES");
        expect
          .soft(state.paths[0]?.versions[0]?.view_error)
          .toContain(join(denied, "dconf"));
      } else
        expect.soft(state.paths).toEqual([
          expect.objectContaining({
            versions: [
              expect.objectContaining({
                view: {
                  groups: { "org/notes": { selected: "true" } },
                  other_groups: [],
                },
                view_error: null,
              }),
            ],
          }),
        ]);
      const helper = join(root, "exported.py");
      await writeFile(
        helper,
        [
          ...PYTHON_IMPORTS.split("\n").filter(
            (line) => !line.includes("agentenv_protocol"),
          ),
          PYTHON_HELPERS,
          'print(_dconf(["dump", "/"], {}, cwd=Path(sys.argv[1])), end="")',
        ].join("\n"),
      );
      const pending = execFileOutput(python, ["-I", helper, staged], {
        cwd,
        env: { PATH: searchPath },
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      });
      if (searchPath === "denied") {
        const failure = await pending.then(
          () => undefined,
          (cause: unknown) => execFileOutputFailure(cause),
        );
        expect(failure?.stderr).toContain("PermissionError");
        expect(failure?.stderr).toContain(join(denied, "dconf"));
      } else {
        const exported = await pending;
        expect(exported.stderr).toBe("");
        expect(exported.stdout).toBe("[org/notes]\nselected=true\n");
      }
    },
  );
}
