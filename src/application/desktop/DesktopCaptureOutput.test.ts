import {
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import type { Evidence } from "../../domain/evidence.js";
import { OwnedFileHandle } from "../../filesystem/OwnedFileHandle.js";
import { CaptureFile, prepareOutputDirectory } from "./DesktopCaptureOutput.js";

const evidence = { id: "evidence" } as unknown as Evidence;

it.each(["", "/child"])(
  "refuses an output path blocked by a regular file (%s)",
  async (suffix) => {
    const root = await createTestTempDirectory("desktop-output-file-");
    const file = join(root, "existing");
    await writeFile(file, "keep");
    await expect(prepareOutputDirectory(`${file}${suffix}`)).resolves.toEqual({
      refusal: "not_a_directory",
    });
    expect(await readFile(file, "utf8")).toBe("keep");
  },
);

describe("CaptureFile", () => {
  it("publishes through its partial file and leaves nothing to discard", async () => {
    const output = await createTestTempDirectory("desktop-output-");
    const captureFile = new CaptureFile(output);

    const published = await captureFile.publish(evidence);
    await captureFile.discard();

    expect(published).toBe(join(output, "capture.json"));
    expect(JSON.parse(await readFile(published, "utf8"))).toEqual(evidence);
    expect(await readdir(output)).toEqual(["capture.json"]);
  });

  it("never removes a partial file another process created", async () => {
    const output = await createTestTempDirectory("desktop-output-foreign-");
    const captureFile = new CaptureFile(output);
    await writeFile(captureFile.partial, "theirs");

    await captureFile.discard();
    await expect(captureFile.publish(evidence)).rejects.toMatchObject({
      code: "EEXIST",
    });
    await captureFile.discard();

    expect(await readFile(captureFile.partial, "utf8")).toBe("theirs");
  });

  it("removes the partial file it created when publication fails", async () => {
    const output = await createTestTempDirectory("desktop-output-rename-");
    const captureFile = new CaptureFile(output);
    await mkdir(join(output, "capture.json", "occupied"), { recursive: true });

    await expect(captureFile.publish(evidence)).rejects.toThrow();
    expect((await readdir(output)).sort()).toEqual([
      "capture.json",
      "capture.json.partial",
    ]);
    await captureFile.discard();

    expect(await readdir(output)).toEqual(["capture.json"]);
  });
});

/** The prototype every `open` handle shares, so a test can fail its writes. */
const fileHandlePrototype = async (directory: string): Promise<FileHandle> => {
  const probe = await open(join(directory, "probe"), "w");
  await probe.close();
  await rm(join(directory, "probe"));
  return Object.getPrototypeOf(probe) as FileHandle;
};

describe("CaptureFile handle cleanup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { writeFails: true, reported: "disk full" },
    { writeFails: false, reported: "close failed" },
  ])(
    "keeps the partial file's handle owned when its close fails (write fails: $writeFails)",
    async ({ writeFails, reported }) => {
      const output = await createTestTempDirectory("desktop-output-close-");
      const captureFile = new CaptureFile(output);
      if (writeFails)
        vi.spyOn(
          await fileHandlePrototype(output),
          "writeFile",
        ).mockRejectedValueOnce(new Error("disk full"));
      const close = vi
        .spyOn(OwnedFileHandle.prototype, "close")
        .mockRejectedValueOnce(new Error("close failed"));

      await expect(captureFile.publish(evidence)).rejects.toThrow(reported);
      const [owned] = close.mock.contexts as OwnedFileHandle[];
      expect(owned?.handle.fd).toBeGreaterThanOrEqual(0);
      await captureFile.close();

      expect(owned?.handle.fd).toBe(-1);
      expect(await readdir(output)).toEqual(["capture.json.partial"]);
      await captureFile.discard();
      expect(await readdir(output)).toEqual([]);
    },
  );
});
