import { access, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, it, vi } from "vitest";

import { createVerifierCommands } from "../../scripts/lib/verify-commands.mjs";
import { withVerifierCleanup } from "../../scripts/lib/verifier-cleanup.mjs";

it.each([false, true])(
  "UF2 verifier retains its workspace until actual resource cleanup succeeds (denied: %s)",
  async (deniedInitially) => {
    const commands = await createVerifierCommands();
    const primary = new Error(
      "controlled esptool refusal after input creation",
    );
    const cleanupFailure = new Error(
      "controlled owned descriptor close denial",
    );
    let denied = deniedInitially;
    let workspace: string | undefined;
    let retained: Awaited<ReturnType<typeof open>> | undefined;
    let peer: Awaited<ReturnType<typeof open>> | undefined;
    let retainedAttempts = 0;
    let peerAttempts = 0;
    let cleanupTasks: readonly (() => void | Promise<void>)[] = [];
    const bytes = Buffer.from(
      Array.from({ length: 1000 }, (_, i) => (i * 13 + 1) & 0xff),
    );
    vi.spyOn(commands, "exec").mockImplementation(async (_command, args) => {
      if (args.at(-1) === "version") return { stdout: "v5.6.0", stderr: "" };
      const outputIndex = args.indexOf("-o");
      const output = args[outputIndex + 1];
      if (outputIndex < 0 || output === undefined)
        throw new Error("Expected generated UF2 output selection");
      workspace = dirname(output);
      retained = await open(`${workspace}/bootloader.bin`, "r");
      peer = await open(`${workspace}/table.bin`, "r");
      const retainedHandle = retained;
      const peerHandle = peer;
      commands.adopt(
        {
          close: async () => {
            retainedAttempts++;
            if (denied) throw cleanupFailure;
            await retainedHandle.close();
          },
        },
        `${workspace}/bootloader.bin`,
      );
      commands.adopt(
        {
          close: async () => {
            peerAttempts++;
            await peerHandle.close();
          },
        },
        `${workspace}/table.bin`,
      );
      throw primary;
    });
    vi.doMock("../../scripts/lib/verify-commands.mjs", () => ({
      createVerifierCommands: async () => commands,
    }));
    vi.doMock("../../scripts/lib/verifier-cleanup.mjs", () => ({
      withVerifierCleanup: (
        operation: () => Promise<unknown>,
        tasks: typeof cleanupTasks,
      ) => {
        cleanupTasks = tasks;
        return withVerifierCleanup(operation, tasks);
      },
    }));
    try {
      const entrypoint = "../../scripts/verify/firmware/uf2-esptool.mjs";
      const failure: unknown = await import(entrypoint).catch(
        (cause: unknown) => cause,
      );
      expect(workspace).toBeDefined();
      if (
        workspace === undefined ||
        retained === undefined ||
        peer === undefined
      )
        throw new Error("Expected real owned workspace descriptors");
      expect(peer.fd).toBe(-1);
      expect(peerAttempts).toBe(1);
      if (deniedInitially) {
        expect(failure).toBeInstanceOf(AggregateError);
        if (!(failure instanceof AggregateError)) throw failure;
        expect(failure.cause).toBe(primary);
        expect(failure.errors[0]).toBe(primary);
        expect(failure.errors[1]).toHaveProperty("cause.errors", [
          cleanupFailure,
        ]);
        expect(commands.cleanupResources).toEqual([
          `${workspace}/bootloader.bin`,
        ]);
        expect(retained.fd).toBeGreaterThanOrEqual(0);
        await access(workspace);
        expect(
          (await readFile(`${workspace}/bootloader.bin`)).equals(bytes),
        ).toBe(true);
        await expect(
          withVerifierCleanup(() => undefined, cleanupTasks),
        ).rejects.toBeInstanceOf(AggregateError);
        await access(workspace);
        expect(retainedAttempts).toBe(2);
        expect(peerAttempts).toBe(1);
        denied = false;
        await withVerifierCleanup(() => undefined, cleanupTasks);
        expect(retainedAttempts).toBe(3);
      } else {
        expect(failure).toBe(primary);
        expect(retainedAttempts).toBe(1);
      }
      expect(commands.cleanupResources).toEqual([]);
      expect(retained.fd).toBe(-1);
      expect(peerAttempts).toBe(1);
      await expect(access(workspace)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      denied = false;
      await commands.close();
      for (const cleanup of cleanupTasks) await cleanup();
      await retained?.close();
      await peer?.close();
      vi.doUnmock("../../scripts/lib/verify-commands.mjs");
      vi.doUnmock("../../scripts/lib/verifier-cleanup.mjs");
      vi.restoreAllMocks();
      vi.resetModules();
    }
  },
);
