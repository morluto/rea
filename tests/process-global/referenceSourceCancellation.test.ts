import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { createCli } from "../../src/cli.js";
import { ArtifactResourceScope } from "../../src/artifacts/ArtifactResourceScope.js";
import { OwnedFileHandle } from "../../src/filesystem/OwnedFileHandle.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { holdFirstFileRead } from "../support/holdFirstFileRead.js";

it.each([
  { signal: "SIGINT", exitCode: 130, phase: "read" },
  { signal: "SIGTERM", exitCode: 143, phase: "read" },
  { signal: "SIGINT", exitCode: 130, phase: "final-close" },
  { signal: "SIGTERM", exitCode: 143, phase: "final-close" },
] as const)(
  "awaits cleanup and reports $signal during reference-source $phase",
  async ({ signal, exitCode, phase }) => {
    const root = await createTestTempDirectory("rea-reference-cli-cancel-");
    const file = join(root, "source.txt");
    const contents = "inert reference text\n".repeat(8192);
    await writeFile(file, contents);
    const held = phase === "read" ? await holdFirstFileRead(file) : undefined;
    let resolveClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    let releaseClose: (() => void) | undefined;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const owners = new Set<OwnedFileHandle>();
    const closeFile = OwnedFileHandle.prototype.close;
    const fileClose = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementation(async function (this: OwnedFileHandle) {
        owners.add(this);
        await closeFile.call(this);
      });
    const closeScope = ArtifactResourceScope.prototype.close;
    const scopeClose = vi
      .spyOn(ArtifactResourceScope.prototype, "close")
      .mockImplementation(async function (this: ArtifactResourceScope) {
        await closeScope.call(this);
        resolveClosed?.();
        await closeGate;
      });
    const previousExitCode = process.exitCode;
    const listeners = {
      SIGINT: process.listenerCount("SIGINT"),
      SIGTERM: process.listenerCount("SIGTERM"),
    };
    let stdout = "";
    let completed = false;
    const running = createCli({})
      .serve(["import-reference-source", root, "--json"], {
        stdout: (part) => {
          stdout += part;
        },
        exit: () => {},
      })
      .finally(() => {
        completed = true;
      });
    try {
      if (held !== undefined) {
        await held.firstRead;
        process.emit(signal);
        held.release();
      }
      await closed;
      if (phase === "final-close") process.emit(signal);
      expect(completed).toBe(false);
      expect(stdout).toBe("");
      expect(owners.size).toBeGreaterThan(0);
      expect([...owners].every((owner) => owner.handle.fd < 0)).toBe(true);
      releaseClose?.();
      await running;
      const result = JSON.parse(stdout);
      expect(result).toMatchObject({
        error: "Import failed",
        code: "cancelled",
        category: "cancelled",
        retryable: true,
      });
      expect(process.exitCode).toBe(exitCode);
      expect(process.listenerCount("SIGINT")).toBe(listeners.SIGINT);
      expect(process.listenerCount("SIGTERM")).toBe(listeners.SIGTERM);
      if (held !== undefined) {
        expect(held.readCount).toBe(1);
        expect(result.details?.diagnostics?.partial).toMatchObject({
          root,
          entries: [
            expect.objectContaining({
              path: "source.txt",
              status: "failed",
              code: "cancelled",
            }),
          ],
        });
      } else
        expect(result.details?.partial_observation).toMatchObject({
          schema: "HistoricalSourceGraph",
          authority: "historical-reference",
          entries: [
            expect.objectContaining({
              path: "source.txt",
              content_state: "hashed",
            }),
          ],
        });
    } finally {
      held?.release();
      releaseClose?.();
      try {
        await running;
      } finally {
        fileClose.mockRestore();
        scopeClose.mockRestore();
        vi.restoreAllMocks();
        process.exitCode = previousExitCode;
      }
    }
    expect(await readFile(file, "utf8")).toBe(contents);
  },
);

it("keeps the import failure and both close failures when SIGTERM arrives during retained cleanup", async () => {
  const root = await createTestTempDirectory("rea-reference-cli-close-");
  const file = join(root, "source.txt");
  await writeFile(file, "inert reference text\n");
  const sourceIdentity = await stat(file);
  const scopes = new Set<ArtifactResourceScope>();
  const owners = new Set<OwnedFileHandle>();
  let finalizing = false;
  const closeFile = OwnedFileHandle.prototype.close;
  const fileClose = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementation(async function (this: OwnedFileHandle) {
      const identity = await this.handle.stat();
      if (
        identity.dev === sourceIdentity.dev &&
        identity.ino === sourceIdentity.ino
      ) {
        owners.add(this);
        throw new Error(
          finalizing ? "retained close denied" : "initial close denied",
        );
      }
      await closeFile.call(this);
    });
  const closeScope = ArtifactResourceScope.prototype.close;
  const scopeClose = vi
    .spyOn(ArtifactResourceScope.prototype, "close")
    .mockImplementation(async function (this: ArtifactResourceScope) {
      scopes.add(this);
      finalizing = true;
      try {
        await closeScope.call(this);
      } finally {
        process.emit("SIGTERM");
      }
    });
  const previousExitCode = process.exitCode;
  const listeners = process.listenerCount("SIGTERM");
  let stdout = "";
  try {
    await createCli({}).serve(["import-reference-source", root, "--json"], {
      stdout: (part) => {
        stdout += part;
      },
      exit: () => {},
    });
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({
      error: "Import failed",
      code: "cleanup_incomplete",
      category: "execution_failure",
      retryable: false,
      details: {
        resources: [file],
        execution_failure: "unreadable_output",
        secondary_failures: [{ code: "cancelled" }],
      },
    });
    expect(stdout).toContain("initial close denied");
    expect(stdout).toContain("retained close denied");
    expect(process.exitCode).toBe(143);
    expect(process.listenerCount("SIGTERM")).toBe(listeners);
    expect(owners.size).toBe(1);
    expect([...owners].every((owner) => owner.handle.fd >= 0)).toBe(true);
  } finally {
    fileClose.mockRestore();
    scopeClose.mockRestore();
    process.exitCode = previousExitCode;
    for (const scope of scopes) await scope.close();
  }
  expect([...owners].every((owner) => owner.handle.fd < 0)).toBe(true);
  expect([...scopes].every((scope) => !scope.hasPending)).toBe(true);
  expect(await readFile(file, "utf8")).toBe("inert reference text\n");
});
