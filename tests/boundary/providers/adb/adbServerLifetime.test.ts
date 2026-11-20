import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";

import { AdbProvider } from "../../../../src/adb/AdbProvider.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { waitFor } from "../../../support/testWait.js";

const posix = test.skipIf(process.platform === "win32");

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * A Node adb stand-in. `start-server` forks a detached server, as adb forks
 * its daemon into a new session, and records its PID. Device commands log
 * their argv, and `shell spawn-child` leaves a detached descendant behind;
 * `shell hold` waits until stopped, recording the signal that stopped it.
 */
const adbFixture = async (root: string): Promise<string> => {
  const adb = join(root, "adb");
  await writeFile(
    adb,
    `#!${process.execPath}
const { appendFileSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
const root = ${JSON.stringify(root)};
appendFileSync(root + "/argv.log", args.join(" ") + "\\n");
const spawnBackground = (name, isDetached) => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: isDetached,
    stdio: "ignore",
  });
  writeFileSync(root + "/" + name + ".pid", String(child.pid));
  child.unref();
};
if (args[0] === "version")
  process.stdout.write("Android Debug Bridge version 1.0.41\\nVersion 35.0.2-fixture\\n");
else if (args[0] === "start-server") {
  process.stderr.write("* daemon not running; starting now at tcp:5037\\n* daemon started successfully\\n");
  spawnBackground("server", true);
} else if (args[0] === "devices")
  process.stdout.write("List of devices attached\\nemulator-5554 device transport_id:1\\n");
else if (args.includes("auto-restart-server")) {
  process.stderr.write("* daemon not running; starting now at tcp:5037\\n* daemon started successfully\\n");
  spawnBackground("replacement-server", true);
} else if (args.includes("spawn-child")) spawnBackground("descendant", false);
else if (args.includes("hold")) {
  process.on("SIGTERM", () => {
    writeFileSync(root + "/stopped-by", "SIGTERM");
    process.exit(143);
  });
  writeFileSync(root + "/holding", "");
  setInterval(() => {}, 1000);
} else process.exitCode = 1;
`,
    { mode: 0o755 },
  );
  return adb;
};

const fixture = async () => {
  const root = await createTestTempDirectory("rea-adb-server-lifetime-");
  const adb = await adbFixture(root);
  const provider = new AdbProvider({ environment: { REA_ADB_PATH: adb } });
  onTestFinished(async () => {
    await provider.close();
    for (const name of ["server", "replacement-server", "descendant"])
      try {
        process.kill(
          Number(await readFile(join(root, `${name}.pid`), "utf8")),
          "SIGKILL",
        );
      } catch {
        // Not started, or already stopped.
      }
  });
  return { root, provider };
};

posix(
  "starts the adb server explicitly before device commands and never stops it",
  async () => {
    const { root, provider } = await fixture();
    const result = await provider.execute({
      operation: "list_adb_devices",
      input: {},
    });
    if (!result.ok) throw result.error;
    expect(result.value.result).toMatchObject({
      may_have_started_adb_server: true,
    });
    expect(
      (await readFile(join(root, "argv.log"), "utf8")).split("\n"),
    ).toEqual(["version", "start-server", "devices -l", ""]);
    const server = Number(await readFile(join(root, "server.pid"), "utf8"));
    // The device command's owned cleanup has finished; the server REA
    // started is an external shared service and keeps running.
    expect(alive(server)).toBe(true);
    await provider.close();
    expect(alive(server)).toBe(true);
  },
);

posix(
  "does not kill a replacement server auto-started by a device command",
  async () => {
    const { root, provider } = await fixture();
    await provider.execute({
      operation: "inspect_adb_package",
      input: { serial: "emulator-5554", package: "auto-restart-server" },
    });
    const replacement = Number(
      await readFile(join(root, "replacement-server.pid"), "utf8"),
    );
    expect(alive(replacement)).toBe(true);
  },
);

posix(
  "stops a descendant a device command leaves behind with the command's cleanup",
  async () => {
    const { root, provider } = await fixture();
    await provider.execute({
      operation: "inspect_adb_package",
      input: { serial: "emulator-5554", package: "spawn-child" },
    });
    const descendant = Number(
      await readFile(join(root, "descendant.pid"), "utf8"),
    );
    await waitFor(() => expect(alive(descendant)).toBe(false));
  },
);

posix(
  "asks a cancelled device command to stop with SIGTERM before its group is killed",
  async () => {
    const { root, provider } = await fixture();
    const controller = new AbortController();
    const pending = provider.execute(
      {
        operation: "inspect_adb_package",
        input: { serial: "emulator-5554", package: "hold" },
      },
      { signal: controller.signal },
    );
    await waitFor(async () =>
      expect(await readFile(join(root, "holding"), "utf8")).toBe(""),
    );
    controller.abort("caller stopped");
    const result = await pending;
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    expect(await readFile(join(root, "stopped-by"), "utf8")).toBe("SIGTERM");
  },
);
