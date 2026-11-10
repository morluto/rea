import { EventEmitter } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { createPackageVerifierCommands } from "../../../scripts/lib/verify-package-commands.mjs";
import { OwnedMcpStdioTransport } from "../../../src/process/OwnedMcpStdioTransport.js";

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
