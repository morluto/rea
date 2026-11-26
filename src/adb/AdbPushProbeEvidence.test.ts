import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { AdbProvider } from "./AdbProvider.js";

const startup =
  "* daemon not running; starting now at tcp:5037\n* daemon started successfully\n";

/**
 * A Node adb stand-in: it logs each argv and answers the push workflow's
 * commands, keeping a copy of the pushed host file for inspection.
 */
const adbFixture = (
  root: string,
  digestOutput: string,
): string => `#!${process.execPath}
const { appendFileSync, copyFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(root, "argv.log"))}, JSON.stringify(args) + "\\n");
const out = (stdout, stderr, code) => {
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
};
const startup = ${JSON.stringify(startup)};
if (args[0] === "version")
  out("Android Debug Bridge version 1.0.41\\nVersion 37.0.0-fixture\\n", "", 0);
else if (args[0] === "start-server") out("", "", 0);
else if (args[2] === "shell" && args[3] === "test" && args[4] === "-d")
  out("", startup, 0);
else if (args[2] === "shell" && args[3] === "test" && args[4] === "-e")
  out("", startup, 1);
else if (args[2] === "push") {
  copyFileSync(args[3], ${JSON.stringify(join(root, "pushed.bin"))});
  out("1 file pushed\\n", "", 0);
} else if (args[2] === "shell" && args[3] === "sha256sum")
  out(${JSON.stringify(digestOutput)}, "", 0);
else out("", "Unexpected adb fixture command", 2);
`;

it.each([false, true])(
  "retains startup probe evidence alongside digest observations (recognized=%s)",
  async (recognized) => {
    const root = await createTestTempDirectory("rea-adb-probe-evidence-");
    const source = join(root, "input.bin");
    const bytes = Buffer.from("caller-owned bytes");
    await writeFile(source, bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const digestOutput = recognized
      ? `${digest}  /sdcard/receiver/input.bin\n`
      : "unrecognized sha256sum fixture output\n";
    const adb = join(root, "adb");
    await writeFile(adb, adbFixture(root, digestOutput), { mode: 0o755 });
    const provider = new AdbProvider({ environment: { REA_ADB_PATH: adb } });
    onTestFinished(() => provider.close());
    const result = await provider.execute({
      operation: "push_adb_file",
      input: {
        serial: "device",
        local_path: source,
        device_path: "/sdcard/receiver",
        overwrite: false,
      },
    });
    if (!result.ok) throw result.error;
    expect(result.value.result).toMatchObject({
      sha256: digest,
      device_sha256: recognized ? digest : null,
      overwritten: false,
      device_digest_source: recognized ? "device_sha256sum" : "unavailable",
    });
    expect(result.value.rawResult).toEqual({
      device_path_probes: {
        directory: {
          stdout: "",
          stderr: startup,
          stdout_bytes: 0,
          stderr_bytes: Buffer.byteLength(startup),
          exit_code: 0,
          signal: null,
          truncated: false,
        },
        existence: {
          stdout: "",
          stderr: startup,
          stdout_bytes: 0,
          stderr_bytes: Buffer.byteLength(startup),
          exit_code: 1,
          signal: null,
          truncated: false,
        },
      },
      ...(recognized
        ? {}
        : { device_sha256sum: { stdout: digestOutput, stderr: "" } }),
    });
    const commands = (await readFile(join(root, "argv.log"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const staged = commands.find((command) => command[2] === "push")?.[3];
    expect(commands).toEqual([
      ["version"],
      ["start-server"],
      ["-s", "device", "shell", "test", "-d", "/sdcard/receiver"],
      ["-s", "device", "shell", "test", "-e", "/sdcard/receiver/input.bin"],
      ["-s", "device", "push", staged, "/sdcard/receiver"],
      ["-s", "device", "shell", "sha256sum", "/sdcard/receiver/input.bin"],
    ]);
    // adb received a staged copy of the caller's bytes, not the caller's file.
    expect(staged).toBeDefined();
    expect(staged).not.toBe(source);
    expect((await readFile(join(root, "pushed.bin"))).equals(bytes)).toBe(true);
    expect((await readFile(source)).equals(bytes)).toBe(true);
    await expect(stat(staged!)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
