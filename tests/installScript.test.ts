import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("curl installer scenarios", () => {
  it("installs only a pinned REA CLI with closed stdin", async () => {
    const fixture = await createFixture();
    const result = await runInstaller(fixture, ["--version", "0.3.0"]);
    expect(result.stdout).toContain("REA 0.3.0 is installed");
    expect(result.stdout).toContain("Run ");
    expect(await readFile(fixture.npmLog, "utf8")).toContain(
      "install --global --prefix",
    );
    expect(await readFile(fixture.reaLog, "utf8")).toBe("--version\n");
    expect(await readdir(fixture.temporary)).toEqual([]);
  });

  it("accepts Node 25 without installing or replacing it", async () => {
    const fixture = await createFixture();
    const result = await runInstaller(fixture, ["--version", "0.3.0"], {
      FAKE_NODE_VERSION: "25.1.0",
    });
    expect(result.stdout).toContain("Runtime: Node.js 25.1.0");
  });

  it("resolves and validates the latest REA release tag", async () => {
    const fixture = await createFixture();
    const result = await runInstaller(fixture);
    expect(result.stdout).toContain("Version: 0.3.0");
  });

  it("prints a dry run without invoking npm", async () => {
    const fixture = await createFixture();
    const result = await runInstaller(fixture, [
      "--version",
      "0.3.0",
      "--dry-run",
    ]);
    expect(result.stdout).toContain("no changes made");
    await expect(readFile(fixture.npmLog, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    ["unsupported Node", { FAKE_NODE_VERSION: "20.0.0" }, "unsupported"],
    ["npm failure", { FAKE_NPM_FAIL: "1" }, "npm package installation failed"],
    ["version mismatch", { FAKE_REA_VERSION: "9.9.9" }, "does not match"],
  ] as const)("fails closed on %s", async (_name, overrides, message) => {
    const fixture = await createFixture();
    await expect(
      runInstaller(fixture, ["--version", "0.3.0"], overrides),
    ).rejects.toMatchObject({ stderr: expect.stringContaining(message) });
  });
});

interface InstallerFixture {
  readonly home: string;
  readonly bin: string;
  readonly temporary: string;
  readonly npmLog: string;
  readonly reaLog: string;
}

const createFixture = async (): Promise<InstallerFixture> => {
  const root = await mkdtemp(join(tmpdir(), "rea-install-test-"));
  roots.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  const temporary = join(root, "tmp");
  const npmLog = join(root, "npm.log");
  const reaLog = join(root, "rea.log");
  await Promise.all([mkdir(home), mkdir(bin), mkdir(temporary)]);
  await executable(
    join(bin, "uname"),
    '#!/bin/sh\n[ "$1" = "-m" ] && echo x86_64 || echo Linux\n',
  );
  await executable(
    join(bin, "node"),
    `#!/bin/sh
if [ "$1" = "-p" ]; then printf '%s\n' "\${FAKE_NODE_VERSION:-24.18.0}"; else exec ${shellQuote(process.execPath)} "$@"; fi
`,
  );
  await executable(
    join(bin, "npm"),
    `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_NPM_LOG"
[ "\${FAKE_NPM_FAIL:-}" = "1" ] && exit 1
prefix="$HOME/.local"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--prefix" ]; then shift; prefix="$1"; fi
  shift
done
mkdir -p "$prefix/bin"
cp "$FAKE_REA_SOURCE" "$prefix/bin/rea"
chmod +x "$prefix/bin/rea"
`,
  );
  await executable(
    join(bin, "curl"),
    '#!/bin/sh\nprintf \'{"tag_name":"rea-agents-0.3.0"}\'\n',
  );
  await executable(
    join(bin, "rea-source"),
    `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_REA_LOG"
[ "$1" = "--version" ] && printf '%s\n' "\${FAKE_REA_VERSION:-0.3.0}"
`,
  );
  return { home, bin, temporary, npmLog, reaLog };
};

const executable = async (path: string, source: string): Promise<void> => {
  await writeFile(path, source);
  await chmod(path, 0o755);
};

const runInstaller = async (
  fixture: InstallerFixture,
  args: readonly string[] = [],
  overrides: Readonly<Record<string, string>> = {},
): Promise<{ readonly stdout: string; readonly stderr: string }> =>
  execFileAsync("/bin/bash", [join(process.cwd(), "install.sh"), ...args], {
    env: {
      ...process.env,
      HOME: fixture.home,
      TMPDIR: fixture.temporary,
      PATH: `${fixture.bin}:/usr/bin:/bin`,
      FAKE_NPM_LOG: fixture.npmLog,
      FAKE_REA_LOG: fixture.reaLog,
      FAKE_REA_SOURCE: join(fixture.bin, "rea-source"),
      ...overrides,
    },
  });

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'"'"'`)}'`;
