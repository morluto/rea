import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import * as machoReader from "../../artifacts/apple/MachoLoadCommandReader.js";
import { inspectAppleIpsInputSchema } from "../../domain/native/appleIps.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { appleIpsBytes } from "../../../tests/fixtures/binaryDiagnostics/appleIps.js";
import { AppleIpsProvider } from "./AppleIpsProvider.js";

it("retains completed join facts when cancellation arrives during join parsing", async () => {
  const root = await createTestTempDirectory("rea-ips-join-cancel-");
  const path = join(root, "report.ips");
  const joinPath = join(root, "image.bin");
  await writeFile(path, appleIpsBytes());
  const image = Buffer.alloc(32);
  image.writeUInt32LE(0xfeedfacf, 0);
  image.writeUInt32LE(0x0100000c, 4);
  image.writeUInt32LE(2, 12);
  await writeFile(joinPath, image);
  const input = inspectAppleIpsInputSchema.parse({ path, join_path: joinPath });
  const provider = new AppleIpsProvider();
  const controller = new AbortController();
  const reason = new Error("cancel while joining selected image");
  const readContainer = machoReader.readMachoContainer;
  const spy = vi
    .spyOn(machoReader, "readMachoContainer")
    .mockImplementationOnce(async (...arguments_) => {
      const container = await readContainer(...arguments_);
      controller.abort(reason);
      return container;
    });
  try {
    const cancelled = await provider.inspect(input, {
      signal: controller.signal,
    });
    if (cancelled.ok) throw new Error("Expected cancellation during join");
    expect(cancelled.error.cause).toBe(reason);
    expect(cancelled.error).toMatchObject({
      _tag: "AnalysisCancelledError",
      cause: reason,
      partialObservation: {
        artifact: { path },
        join: {
          status: "selected",
          path: joinPath,
          slices: [{ arch: "arm64" }],
        },
        join_artifact: { path: joinPath },
      },
    });
    const recovered = await provider.inspect(input);
    if (!recovered.ok) throw recovered.error;
    expect(recovered.value.join).toMatchObject({
      status: "selected",
      path: joinPath,
    });
  } finally {
    spy.mockRestore();
    await provider.close();
  }
});
