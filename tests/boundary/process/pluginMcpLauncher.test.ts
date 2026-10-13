import { spawn } from "node:child_process";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";

import { packageRunnerCommand } from "../../../scripts/lib/packageRunnerCommand.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const launcher = fileURLToPath(
  new URL("../../../scripts/plugin-mcp-launcher.mjs", import.meta.url),
);

const start = (path: string, packageSpecifier = "rea-agents@6.4.0") => {
  const child = spawn(process.execPath, [launcher, packageSpecifier], {
    env: {
      ...process.env,
      PATH: `${path}${delimiter}${process.env.PATH ?? ""}`,
    },
    stdio: "pipe",
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on(
    "data",
    (bytes: Buffer) => (stdout += bytes.toString("utf8")),
  );
  child.stderr.on(
    "data",
    (bytes: Buffer) => (stderr += bytes.toString("utf8")),
  );
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await closed;
  });
  return { child, closed };
};

const fakeRunner = async (body: string) => {
  const root = await createTestTempDirectory("rea-plugin-launcher-");
  const bin = join(root, "plugin with spaces", "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "npx"), `#!${process.execPath}\n${body}\n`, {
    mode: 0o755,
  });
  return bin;
};

it("escapes a Windows temporary prefix through cmd.exe and npx.cmd", () => {
  expect(
    packageRunnerCommand("npx", "rea-agents@6.4.0", "win32", "C:\\Temp&A"),
  ).toEqual([
    "cmd.exe",
    "/d",
    "/c",
    "npx",
    "-y",
    "--prefix=C:\\Temp^^^&A",
    "rea-agents@6.4.0",
    "mcp",
  ]);
});

it("rejects command separators in a Windows temporary prefix", () => {
  expect(() =>
    packageRunnerCommand("npx", "rea-agents@6.4.0", "win32", "C:\\Temp\nA"),
  ).toThrow("command separator");
});

it.skipIf(process.platform === "win32")(
  "passes the exact pin and protocol streams through the source-only plugin launcher",
  async () => {
    const bin = await fakeRunner(`
      process.stderr.write(JSON.stringify(process.argv.slice(2)));
      process.stdin.pipe(process.stdout);
      process.stdin.on("end", () => { process.exitCode = 7; });
    `);
    const { child, closed } = start(bin, "rea-agents@6.4.0-rc.1");
    child.stdin.end('{"jsonrpc":"2.0","id":1}\n');
    expect(await closed).toEqual({
      code: 7,
      signal: null,
      stdout: '{"jsonrpc":"2.0","id":1}\n',
      stderr: expect.stringMatching(
        /^\["-y","--prefix=.+","rea-agents@6\.4\.0-rc\.1","mcp"\]$/u,
      ),
    });
  },
);

it.skipIf(process.platform === "win32")(
  "forwards termination to the live package-runner child before exiting",
  async () => {
    const bin = await fakeRunner(`
      process.on("SIGTERM", () => { process.stderr.write("stopped"); process.exit(0); });
      process.stdout.write("ready");
      process.stdin.resume();
    `);
    const { child, closed } = start(bin);
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("error", reject);
    });
    child.kill("SIGTERM");
    expect(await closed).toMatchObject({ code: 0, stderr: "stopped" });
  },
);

it.skipIf(process.platform === "win32")(
  "isolates local package resolution and removes the owned runner directory",
  async () => {
    const bin = await fakeRunner(
      "process.stdout.write(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));",
    );
    const { child, closed } = start(bin);
    child.stdin.end();
    const result = await closed;
    expect(result.code).toBe(0);
    const observed = JSON.parse(result.stdout) as {
      cwd: string;
      args: string[];
    };
    expect(observed.cwd).toBe(process.cwd());
    const prefix = observed.args[1]?.slice("--prefix=".length);
    expect(prefix).toContain("rea-plugin-launcher-");
    await expect(lstat(prefix!)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it("rejects a shell expression instead of treating it as the pinned package", async () => {
  const root = await createTestTempDirectory("rea-plugin-invalid-pin-");
  const { child, closed } = start(root, "rea-agents@6.4.0&echo wrong");
  child.stdin.end();
  expect(await closed).toMatchObject({
    code: 1,
    stdout: "",
    stderr: "REA plugin requires one exact rea-agents@VERSION pin.\n",
  });
});
