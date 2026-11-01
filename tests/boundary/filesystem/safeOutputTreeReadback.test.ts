import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { SafeOutputTree } from "../../../src/artifacts/SafeOutputTree.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const state = vi.hoisted(() => ({
  path: "",
  replacement: undefined as Buffer | undefined,
  afterSync: undefined as (() => Promise<void>) | undefined,
  controller: undefined as AbortController | undefined,
  blockClose: false,
  records: [] as {
    created: boolean;
    reads: () => number;
    closeReadCounts: number[];
  }[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (args[0] !== state.path) return handle;
      const read = vi.spyOn(handle, "read");
      const record = {
        created:
          typeof args[1] === "number" && (args[1] & constants.O_CREAT) !== 0,
        reads: () => read.mock.calls.length,
        closeReadCounts: [] as number[],
      };
      state.records.push(record);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await sync();
        if (state.replacement !== undefined)
          await fs.writeFile(state.path, state.replacement);
        await state.afterSync?.();
        state.controller?.abort("cancel after durable write");
      };
      const close = handle.close.bind(handle);
      handle.close = async () => {
        record.closeReadCounts.push(record.reads());
        if (state.blockClose) throw new Error("held output descriptor");
        await close();
      };
      return handle;
    },
  };
});

beforeEach(() => {
  state.path = "";
  state.replacement = undefined;
  state.afterSync = undefined;
  state.controller = undefined;
  state.blockClose = false;
  state.records = [];
});

const fixture = async (bytes = Buffer.from("checked bytes")) => {
  const root = await createTestTempDirectory("rea-readback-owner-");
  const tree = await SafeOutputTree.create(join(root, "output"));
  state.path = join(tree.outputRoot, "payload.bin");
  onTestFinished(async () => {
    state.blockClose = false;
    await tree.rollback();
  });
  const write = (signal?: AbortSignal) =>
    tree.write(
      "payload.bin",
      Readable.from([bytes]),
      {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      },
      signal,
    );
  return { root, tree, write };
};

it.each([0, 96 * 1024])(
  "verifies %i bytes through the synced creation descriptor before closing it",
  async (size) => {
    const bytes = Buffer.alloc(size, 0x61);
    const { write } = await fixture(bytes);
    expect(await write()).toMatchObject({ bytesWritten: size });
    expect(state.records).toHaveLength(1);
    expect(state.records[0]?.created).toBe(true);
    expect(state.records[0]?.closeReadCounts[0]).toBeGreaterThan(0);
    expect((await readFile(state.path)).equals(bytes)).toBe(true);
  },
);

it.each(["CHECKED bytes", "short", "checked bytes plus trailing bytes"])(
  "retains physical readback integrity for altered bytes %s",
  async (altered) => {
    const { write } = await fixture();
    state.replacement = Buffer.from(altered);
    await expect(write()).rejects.toMatchObject({ reason: "integrity" });
  },
);

it("observes cancellation between sync and readback", async () => {
  const { write } = await fixture();
  const controller = new AbortController();
  state.controller = controller;
  await expect(write(controller.signal)).rejects.toMatchObject({
    reason: "cancelled",
  });
});

it("retains a failed close owner until a confirmed retry", async () => {
  const { tree, write } = await fixture();
  state.blockClose = true;
  await expect(write()).rejects.toThrow("held output descriptor");
  await expect(tree.closeHandles()).rejects.toThrow("remain open");
  state.blockClose = false;
  await tree.closeHandles();
  expect(await readFile(state.path, "utf8")).toBe("checked bytes");
});

it("keeps cancellation and the unresolved close obligation distinct", async () => {
  const { tree, write } = await fixture();
  const controller = new AbortController();
  state.controller = controller;
  state.blockClose = true;
  await expect(write(controller.signal)).rejects.toMatchObject({
    reason: "cancelled",
  });
  await expect(tree.closeHandles()).rejects.toThrow("remain open");
  state.blockClose = false;
  await tree.closeHandles();
  expect(await readFile(state.path, "utf8")).toBe("checked bytes");
});

it("rejects a replaced path instead of trusting the retained descriptor alone", async () => {
  const { root, tree, write } = await fixture();
  const moved = join(root, "displaced-owned-file");
  state.afterSync = async () => {
    await rename(state.path, moved);
    await writeFile(state.path, "foreign bytes");
  };
  await expect(write()).rejects.toMatchObject({ reason: "path" });
  await tree.closeHandles();
  expect(await readFile(state.path, "utf8")).toBe("foreign bytes");
  await rm(state.path);
  await rename(moved, state.path);
});
