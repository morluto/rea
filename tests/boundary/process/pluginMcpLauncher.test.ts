import { spawn } from "node:child_process";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";

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
      stderr: '["-y","rea-agents@6.4.0-rc.1","mcp"]',
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
    const bin = await fakeRunner("process.stdout.write(process.cwd());");
    const { child, closed } = start(bin);
    child.stdin.end();
    const result = await closed;
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("rea-plugin-launcher-");
    expect(result.stdout).not.toBe(process.cwd());
    await expect(lstat(result.stdout)).rejects.toMatchObject({
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
