import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { SafeOutputTree } from "../../../src/resources/SafeOutputTree.js";

const { mockOpen } = vi.hoisted(() => ({ mockOpen: vi.fn() }));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  open: mockOpen,
}));

const openDestinationCount = (destination: string): number =>
  mockOpen.mock.calls.filter(([path]) => path === destination).length;

beforeEach(async () => {
  const { open } =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  mockOpen.mockImplementation(async (...args: Parameters<typeof open>) =>
    open(...args),
  );
});

afterEach(() => {
  mockOpen.mockReset();
});

describe("safe artifact output readback", () => {
  it("reads the durable bytes back through the write descriptor (#8410)", async () => {
    const parent = await createTestTempDirectory("rea-safe-output-readback-");
    const output = join(parent, "published");
    const destination = join(output, "nested", "file.txt");
    const tree = await SafeOutputTree.create(output);
    const bytes = Buffer.from("owned bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    const written = await tree.write("nested/file.txt", Readable.from(bytes), {
      sha256,
      bytes: bytes.byteLength,
    });
    expect(written).toEqual({
      relativePath: "nested/file.txt",
      sha256,
      bytesWritten: bytes.byteLength,
    });
    // A second open per file is what made many-file extraction wait: on
    // Windows the reopen has to wait for the real-time scan of the file
    // that was just written. The readback must reuse the write descriptor.
    expect(openDestinationCount(destination)).toBe(1);
    const [flags] = mockOpen.mock.calls
      .find(([path]) => path === destination)
      ?.slice(1) ?? [undefined];
    expect(typeof flags).toBe("number");
    expect((flags as number) & constants.O_RDWR).toBe(constants.O_RDWR);

    expect(await readFile(destination, "utf8")).toBe("owned bytes");
    await tree.commit();
  });

  it("still refuses bytes rewritten in place after the sync (#8410)", async () => {
    const parent = await createTestTempDirectory("rea-safe-output-tamper-");
    const output = join(parent, "published");
    const destination = join(output, "file.txt");
    const { open } =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    const prototypeHandle = await open(join(parent, "handle"), "w");
    const handlePrototype = Object.getPrototypeOf(prototypeHandle) as Pick<
      typeof prototypeHandle,
      "sync"
    >;
    await prototypeHandle.close();
    const tree = await SafeOutputTree.create(output);
    const bytes = Buffer.from("owned bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const originalSync = handlePrototype.sync;
    const sync = vi.spyOn(handlePrototype, "sync");
    sync.mockImplementationOnce(async function (this: typeof prototypeHandle) {
      await originalSync.apply(this);
      // Same inode, same length, different bytes: only the readback hash
      // can catch this. The replacement must land after the sync so the
      // write hash still matches the declared digest.
      await writeFile(destination, "forged byte");
    });
    try {
      await expect(
        tree.write("file.txt", Readable.from(bytes), {
          sha256,
          bytes: bytes.byteLength,
        }),
      ).rejects.toThrow("Durable readback verification failed");
    } finally {
      sync.mockRestore();
      expect(await tree.rollback()).toEqual({
        status: "complete",
        residualPaths: [],
      });
    }
  });
});
