import { EventEmitter } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { createPackageVerifierCommands } from "../../../scripts/lib/verify-package-commands.mjs";
import { OwnedMcpStdioTransport } from "../../../src/process/OwnedMcpStdioTransport.js";
import { resolveSwiftcCompileTimeoutMs } from "../../../src/process/DarwinProcessRunTokenReader.js";

it("retains the workspace until an owned protocol cleanup can be retried", async () => {
  const path = await mkdtemp(join(tmpdir(), "rea-verifier-transport-"));
  const process = Object.assign(new EventEmitter(), {
    pid: 1,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: () => true,
  });
  let refuse = true;
  const transport = new OwnedMcpStdioTransport(
    { command: "fixture", arguments: [] },
    {
      provider: "fixture",
      label: "Fixture",
      maxFrameBytes: 1024,
      maxOperationBytes: 4096,
    },
    async ({ runId }) => ({
      process,
      ownership: { runId, leaderPid: 1, processGroupId: 1 },
      cleanup: async () => {
        if (refuse)
          return { cleaned: false, reason: "injected cleanup failure" };
        process.emit("close", 0, null);
        process.stdout.end();
        process.stderr.end();
        process.stdin.end();
        return { cleaned: true, signaled: false };
      },
    }),
  );
  const commands = await createPackageVerifierCommands({
    workspace: {
      path,
      close: () => rm(path, { recursive: true, force: true }),
    },
  });
  commands.adopt(transport, "protocol child");
  try {
    await transport.start();
    // The group can still contain work after the leader's exit.
    process.emit("exit", 0, null);
    await expect(commands.close()).rejects.toMatchObject({
      path,
      cleanupOwner: commands,
    });
    await expect(access(path)).resolves.toBeUndefined();
    refuse = false;
    await commands.close();
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});

it(
  "joins an owned protocol process and its descendant before closing",
  async () => {
    const { writeFile, readFile } = await import("node:fs/promises");
    const { createOwnedMcpStdioTransport } =
      await import("../../../scripts/lib/owned-mcp-stdio.mjs");
    const path = await mkdtemp(join(tmpdir(), "rea-verifier-real-transport-"));
    const fixture = join(path, "child.cjs");
    const marker = join(path, "pids.json");
    await writeFile(
      fixture,
      `const {spawn}=require('node:child_process');
process.on('SIGTERM',()=>{});
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
require('node:fs').writeFileSync(process.argv[2],JSON.stringify([process.pid,child.pid]));
setInterval(()=>{},1000);`,
    );
    const transport = await createOwnedMcpStdioTransport({
      command: process.execPath,
      arguments: [fixture, marker],
      hostEnvironment: process.env,
      cwd: process.cwd(),
      expectedCommand: null,
      sweepTokenOwnedProcesses: true,
    });
    try {
      await transport.start();
      const deadline = Date.now() + 10_000;
      let pids: number[] | undefined;
      while (pids === undefined) {
        try {
          pids = JSON.parse(await readFile(marker, "utf8")) as number[];
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
          if (Date.now() >= deadline) throw new Error("Child did not start");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(pids).toHaveLength(2);
      await transport.close();
      for (const pid of pids)
        expect(() => process.kill(pid, 0)).toThrowError(
          expect.objectContaining({ code: "ESRCH" }),
        );
    } finally {
      await transport.close();
      await rm(path, { recursive: true, force: true });
    }
  },
  Math.min(
    2_147_483_647,
    30_000 +
      (process.platform === "darwin" ? resolveSwiftcCompileTimeoutMs() : 0),
  ),
);
