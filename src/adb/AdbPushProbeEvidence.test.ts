import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { execFileBytes, execFileOutput } from "../process/ExecFileOutput.js";
import { AdbProvider } from "./AdbProvider.js";
vi.mock("../process/ExecFileOutput.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/ExecFileOutput.js")>()),
  execFileBytes: vi.fn(),
  execFileOutput: vi.fn(),
}));
const startup =
  "* daemon not running; starting now at tcp:5037\n* daemon started successfully\n";
it.each([false, true])(
  "retains startup probe evidence alongside digest observations (recognized=%s)",
  async (recognized) => {
    vi.clearAllMocks();
    const root = await mkdtemp(join(tmpdir(), "rea-adb-probe-evidence-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const source = join(root, "input.bin");
    const bytes = Buffer.from("caller-owned bytes");
    await writeFile(source, bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const provider = new AdbProvider({
      environment: { REA_ADB_PATH: process.execPath },
    });
    onTestFinished(() => provider.close());
    vi.mocked(execFileOutput).mockImplementation(async (_binary, args) => {
      expect(args).toEqual(["version"]);
      const stdout =
        "Android Debug Bridge version 1.0.41\nVersion 37.0.0-fixture\n";
      return {
        stdout,
        stderr: "",
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: 0,
      };
    });
    const digestOutput = recognized
      ? `${digest}  /sdcard/receiver/input.bin\n`
      : "unrecognized sha256sum fixture output\n";
    const commands: string[][] = [];
    let staged: string | undefined;
    vi.mocked(execFileBytes).mockImplementation(async (_binary, args) => {
      const command = [...args];
      commands.push(command);
      expect(command.slice(0, 2)).toEqual(["-s", "device"]);
      if (
        command[2] === "shell" &&
        command[3] === "test" &&
        command[4] === "-d"
      )
        return { stdout: Buffer.alloc(0), stderr: Buffer.from(startup) };
      if (
        command[2] === "shell" &&
        command[3] === "test" &&
        command[4] === "-e"
      )
        throw Object.assign(new Error("absent"), {
          code: 1,
          signal: null,
          killed: false,
          stdout: "",
          stderr: startup,
        });
      if (command[2] === "push") {
        staged = command[3];
        expect(staged).not.toBe(source);
        expect((await readFile(staged!)).equals(bytes)).toBe(true);
        return {
          stdout: Buffer.from("1 file pushed\n"),
          stderr: Buffer.alloc(0),
        };
      }
      if (command[2] === "shell" && command[3] === "sha256sum")
        return { stdout: Buffer.from(digestOutput), stderr: Buffer.alloc(0) };
      throw new Error("Unexpected adb fixture command");
    });
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
    expect(commands.map((command) => command.slice(2, 5))).toEqual([
      ["shell", "test", "-d"],
      ["shell", "test", "-e"],
      ["push", staged, "/sdcard/receiver"],
      ["shell", "sha256sum", "/sdcard/receiver/input.bin"],
    ]);
    expect((await readFile(source)).equals(bytes)).toBe(true);
    expect(staged).toBeDefined();
    await expect(stat(staged!)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
