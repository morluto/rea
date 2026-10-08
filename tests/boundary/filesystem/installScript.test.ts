import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execFileAsync = promisify(execFile);

describe("curl installer scenarios", { timeout: 20_000 }, () => {
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

  it.each(["22.19.0", "24.11.0", "26.0.0"])(
    "accepts supported Node %s without installing or replacing it",
    async (version) => {
      const fixture = await createFixture();
      const result = await runInstaller(
        fixture,
        ["--version", "0.3.0", "--dry-run"],
        {
          FAKE_NODE_VERSION: version,
        },
      );
      expect(result.stdout).toContain(`Runtime: Node.js ${version}`);
    },
  );

  it.each(["22.18.9", "24.10.9", "23.0.0", "26.0.0-rc.1"])(
    "rejects unsupported Node %s before invoking npm",
    async (version) => {
      const fixture = await createFixture();
      await expect(
        runInstaller(fixture, ["--version", "0.3.0"], {
          FAKE_NODE_VERSION: version,
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(`Node.js ${version} is unsupported`),
      });
      await expect(readFile(fixture.npmLog, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

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

  // Keep each distinct failure route while checking its reason and recovery.
  it.each([
    [
      "unsupported Node",
      ["--version", "0.3.0"],
      { FAKE_NODE_VERSION: "20.0.0" },
      "REA installation failed: Node.js 20.0.0 is unsupported; use Node.js 22.x (>=22.19), 24.x (>=24.11), or 26+.\n",
    ],
    [
      "unreadable Node version",
      ["--version", "0.3.0"],
      { FAKE_NODE_VERSION: "invalid" },
      "REA installation failed: the active Node.js version could not be read. Check that node works and is on PATH, then retry.\n",
    ],
    [
      "release lookup",
      [],
      { FAKE_CURL_FAIL: "1" },
      "REA installation failed: the latest REA release could not be resolved. Check network access or pass --version VERSION, then retry.\n",
    ],
    [
      "release response",
      [],
      { FAKE_CURL_BODY: "not-json" },
      "REA installation failed: the release response was invalid. Retry later or pass --version VERSION.\n",
    ],
    [
      "release tag",
      [],
      { FAKE_CURL_BODY: '{"tag_name":"unrelated-1.0.0"}' },
      "REA installation failed: the latest release tag was invalid. Retry later or pass --version VERSION.\n",
    ],
    [
      "npm failure",
      ["--version", "0.3.0"],
      { FAKE_NPM_FAIL: "1" },
      "REA installation failed: npm could not install REA. Check registry access and npm permissions, then retry.\n",
    ],
    [
      "npm prefix",
      ["--version", "0.3.0"],
      { FAKE_PLATFORM: "Darwin", FAKE_NPM_PREFIX_FAIL: "1" },
      "REA installation failed: the npm global prefix could not be read. Repair the npm configuration, then retry.\n",
    ],
    [
      "missing installed command",
      ["--version", "0.3.0"],
      { FAKE_NPM_SKIP_BINARY: "1" },
      "REA installation failed: npm completed without installing the rea command. Check the npm global bin directory and PATH, then retry.\n",
    ],
    [
      "unreadable installed version",
      ["--version", "0.3.0"],
      { FAKE_REA_VERSION_FAIL: "1" },
      "REA installation failed: the installed REA version could not be read. Reinstall the requested version, then retry.\n",
    ],
    [
      "version mismatch",
      ["--version", "0.3.0"],
      { FAKE_REA_VERSION: "9.9.9" },
      "REA installation failed: installed version 9.9.9 does not match 0.3.0. Reinstall the requested version, then retry.\n",
    ],
  ] as const)(
    "fails closed with actionable recovery for %s",
    async (_name, args, overrides, message) => {
      const fixture = await createFixture();
      const failure = await runInstaller(fixture, args, overrides).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      expect(failure).toBeInstanceOf(Error);
      const stderr = String((failure as { stderr?: unknown }).stderr ?? "");
      expect(stderr).toBe(message);
      expect(await readdir(fixture.temporary)).toEqual([]);
    },
  );

  it("reports exact recovery when curl is missing", async () => {
    const fixture = await createFixture();
    await rm(join(fixture.bin, "curl"));
    await expect(
      runInstaller(fixture, ["--version", "0.3.0"], {
        PATH: fixture.bin,
      }),
    ).rejects.toMatchObject({
      stderr:
        "REA installation failed: curl is required. Install curl, then rerun this installer.\n",
    });
  });
});

describe("native macOS installer", { timeout: 20_000 }, () => {
  it("installs on Darwin with an empty prefix argument array", async () => {
    const fixture = await createFixture();
    const result = await runInstaller(fixture, ["--version", "0.3.0"], {
      FAKE_PLATFORM: "Darwin",
      FAKE_NPM_PREFIX: join(fixture.home, "npm global prefix"),
    });
    expect(result.stdout).toContain("REA 0.3.0 is installed");
    expect(await readFile(fixture.npmLog, "utf8")).toBe(
      "prefix --global\ninstall --global rea-agents@0.3.0\n",
    );
    expect(await readFile(fixture.reaLog, "utf8")).toBe("--version\n");
    expect(await readdir(fixture.temporary)).toEqual([]);
  });
});

describe("installer semantic version parsing", { timeout: 20_000 }, () => {
  it.each(["1.2.3-01"])(
    "rejects malformed semantic versions before invoking npm: %s",
    async (version) => {
      const fixture = await createFixture();
      await expect(
        runInstaller(fixture, ["--version", version, "--dry-run"]),
      ).rejects.toMatchObject({
        stderr:
          "REA installation failed: version must be an exact semantic version.\n",
      });
      await expect(readFile(fixture.npmLog, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("rejects valid build metadata before printing a plan or invoking npm", async () => {
    const fixture = await createFixture();
    const failure = await runInstaller(fixture, [
      "--version",
      "1.2.3+build.01",
      "--dry-run",
    ]).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(Error);
    const stderr = getProcessOutput(failure, "stderr");
    expect(stderr).toBe(
      "REA installation failed: npm cannot install an exact version with build metadata. Pass a version without build metadata, then retry.\n",
    );
    expect(getProcessOutput(failure, "stdout")).not.toContain(
      "REA install plan",
    );
    await expect(readFile(fixture.npmLog, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("accepts a valid prerelease version without build metadata", async () => {
    const fixture = await createFixture();
    const result = await runInstaller(fixture, [
      "--version",
      "1.2.3-alpha.0",
      "--dry-run",
    ]);
    expect(result.stdout).toContain("Version: 1.2.3-alpha.0");
    await expect(readFile(fixture.npmLog, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects build metadata in the latest release tag before printing a plan", async () => {
    const fixture = await createFixture();
    const failure = await runInstaller(fixture, [], {
      FAKE_CURL_BODY: '{"tag_name":"rea-agents-1.2.3+build.01"}',
    }).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(getProcessOutput(failure, "stderr")).toBe(
      "REA installation failed: npm cannot install an exact version with build metadata. Pass a version without build metadata, then retry.\n",
    );
    expect(getProcessOutput(failure, "stdout")).not.toContain(
      "REA install plan",
    );
    await expect(readFile(fixture.npmLog, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects an invalid semantic version from the latest release tag", async () => {
    const fixture = await createFixture();
    await expect(
      runInstaller(fixture, [], {
        FAKE_CURL_BODY: '{"tag_name":"rea-agents-1.2.3-01"}',
      }),
    ).rejects.toMatchObject({
      stderr:
        "REA installation failed: the latest release tag was invalid. Retry later or pass --version VERSION.\n",
    });
    await expect(readFile(fixture.npmLog, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

interface InstallerFixture {
  readonly home: string;
  readonly bin: string;
  readonly temporary: string;
  readonly npmLog: string;
  readonly reaLog: string;
}

const getProcessOutput = (
  failure: unknown,
  stream: "stdout" | "stderr",
): string => {
  if (!(failure instanceof Error)) return "";
  if (stream === "stdout" && "stdout" in failure) {
    return typeof failure.stdout === "string" ? failure.stdout : "";
  }
  if (stream === "stderr" && "stderr" in failure) {
    return typeof failure.stderr === "string" ? failure.stderr : "";
  }
  return "";
};

const createFixture = async (): Promise<InstallerFixture> => {
  const root = await createTestTempDirectory("rea-install-test-");
  const home = join(root, "home");
  const bin = join(root, "bin");
  const temporary = join(root, "tmp");
  const npmLog = join(root, "npm.log");
  const reaLog = join(root, "rea.log");
  await Promise.all([mkdir(home), mkdir(bin), mkdir(temporary)]);
  await Promise.all([
    executable(
      join(bin, "uname"),
      '#!/bin/sh\n[ "$1" = "-m" ] && echo x86_64 || printf \'%s\\n\' "${FAKE_PLATFORM:-Linux}"\n',
    ),
    executable(
      join(bin, "node"),
      `#!/bin/sh
if [ "$1" = "-p" ]; then printf '%s\n' "\${FAKE_NODE_VERSION:-24.18.0}"; else exec ${shellQuote(process.execPath)} "$@"; fi
`,
    ),
    executable(
      join(bin, "npm"),
      `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_NPM_LOG"
[ "$1" = "prefix" ] && { [ "\${FAKE_NPM_PREFIX_FAIL:-}" = "1" ] && exit 1; printf '%s\n' "$FAKE_NPM_PREFIX"; exit 0; }
[ "\${FAKE_NPM_FAIL:-}" = "1" ] && exit 1
prefix="$HOME/.local"
[ "\${FAKE_PLATFORM:-Linux}" = "Darwin" ] && prefix="$FAKE_NPM_PREFIX"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--prefix" ]; then shift; prefix="$1"; fi
  shift
done
[ "\${FAKE_NPM_SKIP_BINARY:-}" = "1" ] && exit 0
mkdir -p "$prefix/bin"
cp "$FAKE_REA_SOURCE" "$prefix/bin/rea"
chmod +x "$prefix/bin/rea"
`,
    ),
    executable(
      join(bin, "curl"),
      `#!/bin/sh
[ "\${FAKE_CURL_FAIL:-}" = "1" ] && exit 1
if [ -n "\${FAKE_CURL_BODY:-}" ]; then printf '%s' "$FAKE_CURL_BODY"; else printf '%s' '{"tag_name":"rea-agents-0.3.0"}'; fi
`,
    ),
    executable(
      join(bin, "rea-source"),
      `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_REA_LOG"
[ "\${FAKE_REA_VERSION_FAIL:-}" = "1" ] && exit 1
[ "$1" = "--version" ] && printf '%s\n' "\${FAKE_REA_VERSION:-0.3.0}"
exit 0
`,
    ),
    ...["chmod", "cp", "mkdir", "tr"].map((command) =>
      symlink(`/usr/bin/${command}`, join(bin, command)),
    ),
  ]);
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
      FAKE_NPM_PREFIX: join(fixture.home, ".npm-global"),
      ...overrides,
    },
  });

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'"'"'`)}'`;
