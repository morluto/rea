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
  it("installs a pinned release with closed stdin and cleans temporary files", async () => {
    const fixture = await createFixture();
    const result = await runInstaller(fixture, { REA_VERSION: "0.3.0" });
    expect(result.stdout).toContain("REA 0.3.0 is installed and ready");
    expect(await readFile(fixture.npmLog, "utf8")).toContain(
      "rea-agents@0.3.0",
    );
    expect(await readdir(fixture.temporary)).toEqual([]);
  });

  it("resolves and validates the latest rea-agents release tag", async () => {
    const fixture = await createFixture();
    const result = await runInstaller(fixture);
    expect(result.stdout).toContain("Installing rea-agents@0.3.0");
  });

  it("bootstraps checksum-verified Node 24 into the user prefix", async () => {
    const fixture = await createFixture();
    const result = await runInstaller(fixture, {
      REA_VERSION: "0.3.0",
      FAKE_OLD_NODE: "1",
      FAKE_NODE_ARCHIVE: fixture.nodeArchive,
      FAKE_NODE_SUMS: fixture.nodeSums,
    });
    expect(result.stdout).toContain("REA 0.3.0 is installed and ready");
    expect(
      await readFile(
        join(fixture.home, ".local/share/rea/node/bin/node"),
        "utf8",
      ),
    ).toContain("24.18.0");
  });

  it("reports fresh Hopper activation as partial success", async () => {
    const fixture = await createFixture();
    const result = await runInstaller(fixture, {
      REA_VERSION: "0.3.0",
      FAKE_SETUP_ACTIONS: '["installed_hopper"]',
    });
    expect(result.stdout).toContain("One user action remains");
    expect(result.stdout).toContain("open Hopper");
  });

  it.each([
    [
      "injected version",
      { REA_VERSION: "0.3.0;touch /tmp/pwned" },
      "exact semantic version",
    ],
    [
      "npm failure",
      { REA_VERSION: "0.3.0", FAKE_NPM_FAIL: "1" },
      "npm package installation failed",
    ],
    [
      "version mismatch",
      { REA_VERSION: "0.3.0", FAKE_REA_VERSION: "9.9.9" },
      "does not match",
    ],
    [
      "malformed setup",
      { REA_VERSION: "0.3.0", FAKE_SETUP_JSON: "not-json" },
      "malformed output",
    ],
    [
      "unhealthy doctor",
      { REA_VERSION: "0.3.0", FAKE_DOCTOR_HEALTHY: "false" },
      "unhealthy required component",
    ],
  ] as const)("fails closed on %s", async (_name, overrides, message) => {
    const fixture = await createFixture();
    await expect(runInstaller(fixture, overrides)).rejects.toMatchObject({
      stderr: expect.stringContaining(message),
    });
  });

  it("is safe to rerun", async () => {
    const fixture = await createFixture();
    await runInstaller(fixture, { REA_VERSION: "0.3.0" });
    await runInstaller(fixture, { REA_VERSION: "0.3.0" });
    expect(
      (await readFile(fixture.npmLog, "utf8")).trim().split("\n"),
    ).toHaveLength(2);
    expect(await readdir(fixture.temporary)).toEqual([]);
  });
});

interface InstallerFixture {
  readonly home: string;
  readonly bin: string;
  readonly temporary: string;
  readonly npmLog: string;
  readonly nodeArchive: string;
  readonly nodeSums: string;
}

const createFixture = async (): Promise<InstallerFixture> => {
  const root = await mkdtemp(join(tmpdir(), "rea-install-test-"));
  roots.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  const temporary = join(root, "tmp");
  const npmLog = join(root, "npm.log");
  const nodeFixture = join(root, "node-v24.18.0-linux-x64");
  const nodeArchive = `${nodeFixture}.tar.xz`;
  const nodeSums = join(root, "SHASUMS256.txt");
  await Promise.all([mkdir(home), mkdir(bin), mkdir(temporary)]);
  const realNode = process.execPath;
  await mkdir(join(nodeFixture, "bin"), { recursive: true });
  await executable(
    join(nodeFixture, "bin/node"),
    `#!/bin/sh\nif [ "$1" = "-p" ]; then echo 24.18.0; else exec ${shellQuote(realNode)} "$@"; fi\n`,
  );
  await executable(
    join(nodeFixture, "bin/npm"),
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 11.16.0; exit 0; fi\nprintf "%s\\n" "$*" >> "$FAKE_NPM_LOG"\nexit 0\n',
  );
  await execFileAsync("tar", [
    "-cJf",
    nodeArchive,
    "-C",
    root,
    "node-v24.18.0-linux-x64",
  ]);
  const checksum = (
    await execFileAsync("sha256sum", [nodeArchive])
  ).stdout.split(" ")[0];
  await writeFile(nodeSums, `${checksum}  node-v24.18.0-linux-x64.tar.xz\n`);
  await executable(
    join(bin, "uname"),
    '#!/bin/sh\n[ "$1" = "-m" ] && echo x86_64 || echo Linux\n',
  );
  await executable(
    join(bin, "node"),
    `#!/bin/sh\nif [ "$1" = "-p" ]; then [ "\${FAKE_OLD_NODE:-}" = "1" ] && echo 20.0.0 || echo 24.18.0; else exec ${shellQuote(realNode)} "$@"; fi\n`,
  );
  await executable(
    join(bin, "npm"),
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 11.16.0; exit 0; fi\nprintf "%s\\n" "$*" >> "$FAKE_NPM_LOG"\n[ "${FAKE_NPM_FAIL:-}" = "1" ] && exit 1\nexit 0\n',
  );
  await executable(
    join(bin, "curl"),
    '#!/bin/sh\nout=""\nurl=""\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "-o" ]; then shift; out="$1"; else url="$1"; fi\n  shift\ndone\ncase "$url" in\n  *node-v24.18.0-linux-x64.tar.xz) cp "$FAKE_NODE_ARCHIVE" "$out" ;;\n  *SHASUMS256.txt) cp "$FAKE_NODE_SUMS" "$out" ;;\n  *) printf \'{"tag_name":"rea-agents-0.3.0"}\' ;;\nesac\n',
  );
  await executable(
    join(bin, "rea"),
    '#!/bin/sh\ncase "$1" in\n--version) printf "%s\\n" "${FAKE_REA_VERSION:-0.3.0}" ;;\nsetup) if [ -n "${FAKE_SETUP_JSON:-}" ]; then printf "%s\\n" "$FAKE_SETUP_JSON"; else printf \'{"status":"ready","actions":%s}\\n\' "${FAKE_SETUP_ACTIONS:-[]}"; fi ;;\ndoctor) printf \'{"healthy":%s,"checks":[]}\\n\' "${FAKE_DOCTOR_HEALTHY:-true}" ;;\nesac\n',
  );
  return { home, bin, temporary, npmLog, nodeArchive, nodeSums };
};

const executable = async (path: string, source: string): Promise<void> => {
  await writeFile(path, source);
  await chmod(path, 0o755);
};

const runInstaller = async (
  fixture: InstallerFixture,
  overrides: Readonly<Record<string, string>> = {},
): Promise<{ readonly stdout: string; readonly stderr: string }> =>
  execFileAsync("/bin/bash", [join(process.cwd(), "install.sh")], {
    env: {
      ...process.env,
      HOME: fixture.home,
      TMPDIR: fixture.temporary,
      PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
      FAKE_NPM_LOG: fixture.npmLog,
      ...overrides,
    },
  });

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'"'"'`)}'`;
