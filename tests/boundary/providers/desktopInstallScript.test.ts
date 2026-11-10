import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { renderInstallScript } from "../../../src/domain/desktop/appExport.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

/** A download name a shell would split and expand unless the script quotes it. */
const DOWNLOAD = "vendor/vari'cad $HOME *.deb";

/**
 * The exported run script, run as agentenv runs it (`cd <prefix> && ./<script>`),
 * with a `dpkg` stub on PATH that records its arguments and exits with `status`.
 */
const runInstallScript = async (status: number) => {
  const root = await createTestTempDirectory("desktop-install-script-");
  const app = join(root, "app");
  const bin = join(root, "bin");
  const recorded = join(root, "dpkg-arguments");
  await mkdir(join(app, "vendor"), { recursive: true });
  await mkdir(bin);
  await writeFile(join(app, DOWNLOAD), "package");
  await writeFile(
    join(bin, "dpkg"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > "$RECORDED"\nexit ${String(status)}\n`,
    { mode: 0o755 },
  );
  await writeFile(
    join(app, "install-package.sh"),
    renderInstallScript({
      url: "https://mirror.example.com/varicad.deb",
      sha256: "d".repeat(64),
      path: DOWNLOAD,
      architecture: "amd64",
      dependencies: [],
      unreadDependencies: [],
    }),
    { mode: 0o755 },
  );
  let failed = false;
  try {
    execFileSync("sh", ["-c", 'cd "$1" && ./install-package.sh', "sh", app], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        RECORDED: recorded,
      },
      stdio: "ignore",
    });
  } catch {
    failed = true;
  }
  const kept = await access(join(app, DOWNLOAD)).then(
    () => true,
    () => false,
  );
  return { failed, kept, arguments_: await readFile(recorded, "utf8") };
};

describe.skipIf(process.platform === "win32")(
  "the exported install script",
  () => {
    it("installs the download with dpkg from the app's folder, then removes it", async () => {
      expect(await runInstallScript(0)).toEqual({
        failed: false,
        kept: false,
        arguments_: `-i\n${DOWNLOAD}\n`,
      });
    });

    it("fails the build, keeping the download, when dpkg fails", async () => {
      expect(await runInstallScript(1)).toMatchObject({
        failed: true,
        kept: true,
      });
    });
  },
);
