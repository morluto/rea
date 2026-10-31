import { spawn } from "node:child_process";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { verifyInferiorInputSink } from "./inferiorInputSink.js";

const terminal = { path: "/dev/pts/none", dev: 0, ino: 0 };

const withChild = async <T>(
  stdin: "ignore" | "pipe",
  use: (pid: string) => Promise<T>,
): Promise<T> => {
  const child = spawn("sleep", ["30"], { stdio: [stdin, "ignore", "ignore"] });
  try {
    if (child.pid === undefined) throw new Error("Inferior did not start");
    return await use(String(child.pid));
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise<void>((resolve, reject) => {
        child.once("exit", () => resolve());
        child.once("error", reject);
      });
      child.kill("SIGKILL");
      await exited;
    }
  }
};

describe.skipIf(process.platform !== "linux")(
  "inferior standard input verification",
  () => {
    it("treats the null device as independent of the debugger", async () => {
      const verifyOwnedIdentity = vi.fn(async () => undefined);
      await expect(
        withChild("ignore", (pid) =>
          verifyInferiorInputSink(pid, terminal, verifyOwnedIdentity),
        ),
      ).resolves.toBe("not-inherited");
      expect(verifyOwnedIdentity).toHaveBeenCalledTimes(2);
    });

    it("treats an open regular input file as independent of the debugger", async () => {
      const directory = await mkdtemp(join(tmpdir(), "rea-inferior-stdin-"));
      const path = join(directory, "input.txt");
      await writeFile(path, "caller-selected input\n");
      const input = await open(path, "r");
      const child = spawn("sleep", ["30"], {
        stdio: [input.fd, "ignore", "ignore"],
      });
      try {
        if (child.pid === undefined) throw new Error("Inferior did not start");
        await expect(
          verifyInferiorInputSink(String(child.pid), terminal),
        ).resolves.toBe("not-inherited");
      } finally {
        if (child.exitCode === null) {
          const exited = new Promise<void>((resolve, reject) => {
            child.once("exit", () => resolve());
            child.once("error", reject);
          });
          child.kill("SIGKILL");
          await exited;
        }
        await input.close();
        await rm(directory, { recursive: true, force: true });
      }
    });

    it("rejects a pipe whose independence from the debugger is unproven", async () => {
      await expect(
        withChild("pipe", (pid) => verifyInferiorInputSink(pid, terminal)),
      ).rejects.toThrow(/unverified/u);
    });

    it("accepts a stably closed stdin only after the owner rechecks identity", async () => {
      const child = spawn(
        "/bin/sh",
        ["-c", "exec 0<&-; printf ready; exec sleep 30"],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      try {
        if (child.pid === undefined) throw new Error("Inferior did not start");
        await new Promise<void>((resolve) =>
          child.stdout.once("data", resolve),
        );
        const verifyOwnedIdentity = vi.fn(async () => undefined);
        await expect(
          verifyInferiorInputSink(
            String(child.pid),
            terminal,
            verifyOwnedIdentity,
          ),
        ).resolves.toBe("not-inherited");
        expect(verifyOwnedIdentity).toHaveBeenCalledTimes(3);
      } finally {
        if (child.exitCode === null) {
          const exited = new Promise<void>((resolve, reject) => {
            child.once("exit", () => resolve());
            child.once("error", reject);
          });
          child.kill("SIGKILL");
          await exited;
        }
      }
    });
  },
);
