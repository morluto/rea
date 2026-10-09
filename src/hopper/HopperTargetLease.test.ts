import { execFile } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireHopperTargetLease,
  acquireLinuxHopperApplicationLease,
} from "./HopperTargetLease.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Hopper target leases", () => {
  it("reports the owning REA session for a duplicate target and profile", async () => {
    const directory = await temporaryDirectory();
    const first = await acquireHopperTargetLease({
      ...leaseInput,
      directory,
      runId: "session-first",
    });
    expect(first.acquired).toBe(true);
    if (!first.acquired) return;

    const duplicate = await acquireHopperTargetLease({
      ...leaseInput,
      directory,
      runId: "session-second",
    });
    expect(duplicate).toMatchObject({
      acquired: false,
      owner: { runId: "session-first", processId: process.pid },
    });

    await first.lease.release();
    const reopened = await acquireHopperTargetLease({
      ...leaseInput,
      directory,
      runId: "session-third",
    });
    expect(reopened.acquired).toBe(true);
    if (reopened.acquired) await reopened.lease.release();
  });

  it("keeps different Hopper profiles independent", async () => {
    const directory = await temporaryDirectory();
    const first = await acquireHopperTargetLease({
      ...leaseInput,
      directory,
      runId: "session-one",
    });
    const second = await acquireHopperTargetLease({
      ...leaseInput,
      directory,
      loaderArgs: ["--aarch64"],
      runId: "session-two",
    });
    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(true);
    if (first.acquired) await first.lease.release();
    if (second.acquired) await second.lease.release();
  });
});

describe("Linux Hopper application leases", () => {
  it("reserves the shared application until its owner releases it", async () => {
    const directory = await temporaryDirectory();
    const first = await acquireLinuxHopperApplicationLease({
      directory,
      runId: "first",
    });
    expect(first.acquired).toBe(true);
    if (!first.acquired) return;
    try {
      expect(
        await acquireLinuxHopperApplicationLease({
          directory,
          runId: "second",
        }),
      ).toMatchObject({
        acquired: false,
        owner: { runId: "first", processId: process.pid },
      });
    } finally {
      await first.lease.release();
    }
    const reopened = await acquireLinuxHopperApplicationLease({
      directory,
      runId: "third",
    });
    expect(reopened.acquired).toBe(true);
    if (reopened.acquired) await reopened.lease.release();
  });

  it.each(["silent", "malformed", "invalid-pid", "closed"] as const)(
    "keeps a live endpoint when its owner response is %s",
    async (behavior) => {
      const directory = await temporaryDirectory();
      const socketPath = await releasedApplicationSocket(directory);
      let responsive = false;
      const sockets = new Set<Socket>();
      const owner = { runId: "existing-owner", processId: process.pid };
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => undefined);
        if (responsive) socket.end(`${JSON.stringify(owner)}\n`);
        else if (behavior === "malformed") socket.end("not JSON\n");
        else if (behavior === "invalid-pid")
          socket.end('{"runId":"existing-owner","processId":-1}\n');
        else if (behavior === "closed") socket.end();
      });
      server.listen(socketPath);
      await once(server, "listening");
      try {
        await expect(
          acquireLinuxHopperApplicationLease({ directory, runId: "new-owner" }),
        ).rejects.toMatchObject({
          _tag: "HopperStartError",
          userMessage: expect.stringContaining("left unchanged"),
        });
        expect((await lstat(socketPath)).isSocket()).toBe(true);
        responsive = true;
        expect(
          await acquireLinuxHopperApplicationLease({
            directory,
            runId: "retry",
          }),
        ).toEqual({
          acquired: false,
          owner,
        });
      } finally {
        for (const socket of sockets) socket.destroy();
        server.close();
        await once(server, "close");
      }
    },
  );

  it("recovers a socket left by a process that exited without releasing it", async () => {
    const directory = await temporaryDirectory();
    const socketPath = await releasedApplicationSocket(directory);
    await promisify(execFile)(process.execPath, [
      "--input-type=module",
      "-e",
      'import {createServer} from "node:net"; createServer().listen(process.argv[1],()=>process.exit(0));',
      socketPath,
    ]);
    expect((await lstat(socketPath)).isSocket()).toBe(true);
    const recovered = await acquireLinuxHopperApplicationLease({
      directory,
      runId: "recovered",
    });
    expect(recovered.acquired).toBe(true);
    if (recovered.acquired) await recovered.lease.release();
  });
});

const releasedApplicationSocket = async (
  directory: string,
): Promise<string> => {
  const initial = await acquireLinuxHopperApplicationLease({
    directory,
    runId: "initial",
  });
  if (!initial.acquired)
    throw new Error("Initial application lease was unavailable");
  const [name] = await readdir(directory);
  await initial.lease.release();
  if (name === undefined)
    throw new Error("Application lease did not create a socket");
  return join(directory, name);
};

const leaseInput = {
  targetPath: "/tmp/sample-binary",
  targetKind: "executable" as const,
  loaderArgs: [],
};

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join("/tmp", "rea-hl-"));
  directories.push(directory);
  return directory;
};
