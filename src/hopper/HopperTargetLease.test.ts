import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acquireHopperTargetLease } from "./HopperTargetLease.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

// Hopper is unsupported on win32: leases bind a Unix socket path, which Node
// maps to a named pipe that cannot be created at a filesystem path.
describe.skipIf(process.platform === "win32")("Hopper target leases", () => {
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

const leaseInput = {
  targetPath: "/tmp/sample-binary",
  targetKind: "executable" as const,
  loaderArgs: [],
};

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "rea-hl-"));
  directories.push(directory);
  return directory;
};
