import { execFileSync } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
      const launch = join(root, "launch:original");
      const tools = join(launch, "tools");
      await mkdir(tools, { recursive: true });
      await symlink("/bin/sh", join(tools, "sh"));
      await writeFile(
        join(tools, "dconf"),
        '#!/usr/bin/env sh\nexec dconf-helper "$@"\n',
        { mode: 0o755 },
      );
      await writeFile(
        join(tools, "dconf-helper"),
        `#!/bin/sh\nexec '${dconf.replaceAll("'", "'\\''")}' "$@"\n`,
        { mode: 0o755 },
      );
      const verification = join(root, "verification-profile");
      await writeFile(verification, "file-db:./user\n");
      for (let replay = 0; replay < 2; replay += 1) {
        const result = await execFileOutput(python, ["-I", helper, home], {
          timeout: 10_000,
          maxBuffer: 64 * 1024,
          cwd: launch,
          env: { PATH: "tools" },
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
for (const searchPath of [
  "tools",
  "",
  "denied:tools",
  "denied",
  "broken:tools",
  "broken:denied",
  "failed:tools",
]) {
  cliTest.skipIf(process.platform === "win32" || !hasPython)(
    `capture and exported helper preserve ${JSON.stringify(searchPath)} PATH from a colon-containing cwd`,
    async ({ cli }) => {
      const root = await createTestTempDirectory("dconf-command-selection-");
      const cwd = join(root, "launch:split");
      const selected = searchPath === "" ? cwd : join(cwd, "tools");
      const denied = join(cwd, "denied");
      const broken = join(cwd, "broken");
      const failed = join(cwd, "failed");
      const foreign = join(root, "launch");
      const staged = join(root, "staged");
      await Promise.all([
        mkdir(selected, { recursive: true }),
        mkdir(denied, { recursive: true }),
        mkdir(broken, { recursive: true }),
        mkdir(failed, { recursive: true }),
        mkdir(foreign),
        mkdir(staged),
      ]);
      await writeFile(
        join(selected, "dconf"),
        `#!/usr/bin/env sh
[ "$PATH" = '${searchPath}' ] || exit 19
dconf-helper
`,
        { mode: 0o755 },
      );
      await symlink("/bin/sh", join(selected, "sh"));
      await writeFile(
        join(selected, "dconf-helper"),
        "#!/bin/sh\nprintf '[org/notes]\\nselected=true\\n'\n",
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
      await writeFile(
        join(broken, "dconf"),
        `#!${join(root, "removed-interpreter")}\n`,
        { mode: 0o755 },
      );
      await writeFile(
        join(failed, "dconf"),
        "#!/bin/sh\nprintf 'selected reader failed' >&2\nexit 17\n",
        { mode: 0o755 },
      );
      if (searchPath === "broken:tools") {
        const control = await execFileOutput("dconf", ["dump", "/"], {
          cwd,
          env: { PATH: searchPath },
          timeout: 10_000,
          maxBuffer: 64 * 1024,
        });
        expect(control.stdout).toBe("[org/notes]\nselected=true\n");
      }
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
      if (searchPath.endsWith("denied")) {
        expect
          .soft(state.paths[0]?.versions[0]?.view_error)
          .toContain("EACCES");
        expect
          .soft(state.paths[0]?.versions[0]?.view_error)
          .toContain(join(denied, "dconf"));
      } else if (searchPath === "failed:tools") {
        expect
          .soft(state.paths[0]?.versions[0]?.view_error)
          .toContain("selected reader failed");
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
          'print(_dconf(["dump", "/"], {}), end="")',
        ].join("\n"),
      );
      const pending = execFileOutput(python, ["-I", helper, staged], {
        cwd,
        env: { PATH: searchPath },
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      });
      if (searchPath.endsWith("denied")) {
        const failure = await pending.then(
          () => undefined,
          (cause: unknown) => execFileOutputFailure(cause),
        );
        expect(failure?.stderr).toContain("PermissionError");
        expect(failure?.stderr).toContain(join(denied, "dconf"));
      } else if (searchPath === "failed:tools") {
        const failure = await pending.then(
          () => undefined,
          (cause: unknown) => execFileOutputFailure(cause),
        );
        expect(failure?.stderr).toContain("CalledProcessError");
        expect(failure?.stderr).toContain("exit status 17");
      } else {
        const exported = await pending;
        expect(exported.stderr).toBe("");
        expect(exported.stdout).toBe("[org/notes]\nselected=true\n");
      }
    },
  );
}

it.skipIf(process.platform === "win32" || !hasPython)(
  "generated dconf retains spawn-capacity and read failures without retry, and reaps its child",
  async () => {
    const root = await createTestTempDirectory("dconf-capture-io-");
    const tools = join(root, "tools");
    await mkdir(tools);
    await writeFile(
      join(tools, "dconf"),
      `#!${python}\nimport time\ntime.sleep(60)\n`,
      { mode: 0o755 },
    );
    const helper = join(root, "io.py");
    await writeFile(
      helper,
      [
        ...PYTHON_IMPORTS.split("\n").filter(
          (line) => !line.includes("agentenv_protocol"),
        ),
        PYTHON_HELPERS,
        "started = []",
        'failure = OSError(errno.EIO, "controlled pipe read failure")',
        "original_popen = subprocess.Popen",
        "class ReadFailure(original_popen):",
        "    def __init__(self, *args, **kwargs):",
        "        super().__init__(*args, **kwargs)",
        "        started.append(self)",
        "    def communicate(self, *args, **kwargs):",
        "        raise failure",
        "subprocess.Popen = ReadFailure",
        "try:",
        '    _dconf(["dump", "/"], {})',
        "except OSError as error:",
        "    assert error is failure",
        "else:",
        '    raise AssertionError("read failure was hidden")',
        "assert len(started) == 1",
        "assert started[0].poll() is not None",
        'capacity = OSError(errno.EAGAIN, "controlled host spawn refusal")',
        "attempted = []",
        "def refuse_spawn(*args, **kwargs):",
        "    attempted.append(args)",
        "    raise capacity",
        "subprocess.Popen = refuse_spawn",
        "try:",
        '    _dconf(["dump", "/"], {})',
        "except OSError as error:",
        "    assert error is capacity",
        "else:",
        '    raise AssertionError("spawn refusal was hidden")',
        "assert len(attempted) == 1",
        'print("read failure preserved; child reaped")',
      ].join("\n"),
    );
    const result = await execFileOutput(python, ["-I", helper], {
      env: { PATH: `${tools}:${tools}` },
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("read failure preserved; child reaped\n");
  },
);
