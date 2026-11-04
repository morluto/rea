import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import type { Evidence } from "../../domain/evidence.js";
import { CaptureFile } from "./DesktopCaptureOutput.js";

const evidence = { id: "evidence" } as unknown as Evidence;

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
