import { access, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, it, vi } from "vitest";

import { createVerifierCommands } from "../../scripts/lib/verify-commands.mjs";

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
        expect(failure).toBeInstanceOf(Error);
        const owned = failure as Error & {
          cleanupLeases: { release(): Promise<void> }[];
        };
        expect(owned.cause).toBeInstanceOf(AggregateError);
        const original = owned.cause as AggregateError;
        expect(original.cause).toBe(primary);
        expect(original.errors[0]).toBe(primary);
        expect(original.errors[1]).toHaveProperty("cause.errors", [
          cleanupFailure,
        ]);
        expect(owned.cleanupLeases).toHaveLength(1);
        expect(commands.cleanupResources).toEqual([
          `${workspace}/bootloader.bin`,
        ]);
        expect(retained.fd).toBeGreaterThanOrEqual(0);
        await access(workspace);
        expect(
          (await readFile(`${workspace}/bootloader.bin`)).equals(bytes),
        ).toBe(true);
        await expect(owned.cleanupLeases[0]!.release()).rejects.toMatchObject({
          cause: expect.objectContaining({ errors: [cleanupFailure] }),
        });
        await access(workspace);
        expect(retainedAttempts).toBe(2);
        expect(peerAttempts).toBe(1);
        denied = false;
        await owned.cleanupLeases[0]!.release();
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
      if (workspace !== undefined)
        await rm(workspace, { recursive: true, force: true });
      await retained?.close();
      await peer?.close();
      vi.doUnmock("../../scripts/lib/verify-commands.mjs");
      vi.restoreAllMocks();
      vi.resetModules();
    }
  },
);
