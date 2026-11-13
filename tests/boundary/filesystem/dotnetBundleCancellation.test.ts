import { once } from "node:events";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { expect, it, vi } from "vitest";
import { DotnetBundleArtifactReader } from "../../../src/artifacts/DotnetBundleArtifactReader.js";
import { dotnetBundleFixture } from "../../../src/artifacts/dotnet/DotnetBundle.fixture.js";
import { createDeferred } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const cases = [false, true].flatMap((compressed) =>
  (["unstarted", "backpressured"] as const).flatMap((phase) =>
    (["null", "object"] as const).map((reasonKind) => ({
      compressed,
      phase,
      reasonKind,
    })),
  ),
);

it("preserves a prefetched descriptor failure when a suspended consumer cancels", async () => {
  const root = await createTestTempDirectory("rea-dotnet-prefetch-cancel-");
  const path = join(root, "host.exe");
  await writeFile(
    path,
    dotnetBundleFixture([
      { path: "member", bytes: Buffer.alloc(128 * 1024, 65) },
    ]).bytes,
  );
  const handle = await open(path, "r");
  const reader = new DotnetBundleArtifactReader(path, {
    handle,
    initial: await handle.stat(),
  });
  const started = createDeferred<void>();
  const pending = createDeferred<void>();
  const physical = Object.assign(new Error("prefetched descriptor failure"), {
    code: "EIO",
  });
  let restore = () => {};
  try {
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    const controller = new AbortController();
    const output = await reader.open(entries[0]!, controller.signal);
    output.on("error", () => undefined);
    const originalRead = handle.read.bind(handle);
    const spy = vi
      .spyOn(handle, "read")
      .mockImplementationOnce(originalRead)
      .mockImplementationOnce(async () => {
        started.resolve();
        await pending.promise;
        throw physical;
      });
    restore = () => spy.mockRestore();
    const ready = once(output, "readable");
    output.read(0);
    await ready;
    await started.promise;
    expect(output.readableLength).toBeGreaterThan(0);
    pending.resolve();
    controller.abort({ stop: "prefetch pending" });
    output.resume();
    await expect(finished(output)).rejects.toMatchObject({
      reason: "io",
      cause: physical,
    });
  } finally {
    pending.resolve();
    restore();
    await reader.close();
    await handle.close();
  }
});

it.each(cases)(
  "retires a $phase .NET member on cancellation (compressed: $compressed, reason: $reasonKind)",
  async ({ compressed, phase, reasonKind }) => {
    const root = await createTestTempDirectory("rea-dotnet-idle-cancel-");
    const path = join(root, "host.exe");
    await writeFile(
      path,
      dotnetBundleFixture([
        // One physical read leaves the outer iterator suspended, with no
        // outstanding prefetch. The separate EIO case covers that state.
        { path: "member", bytes: Buffer.alloc(1024, 65), compressed },
      ]).bytes,
    );
    const reader = new DotnetBundleArtifactReader(path);
    try {
      const entries = [];
      for await (const entry of reader.entries()) entries.push(entry);
      const controller = new AbortController();
      const output = await reader.open(entries[0]!, controller.signal);
      const errors: Error[] = [];
      output.on("error", (error) => errors.push(error));
      if (phase === "backpressured") {
        const ready = once(output, "readable");
        output.read(0);
        await ready;
        expect(output.readableLength).toBeGreaterThan(0);
      }
      const reason = reasonKind === "null" ? null : { stop: "idle member" };
      controller.abort(reason);
      // Cancellation must not require a consumer to resume the iterator first.
      expect(output.destroyed).toBe(true);
      await expect(finished(output)).rejects.toMatchObject({
        reason: "cancelled",
      });
      expect(errors[0]?.cause).toBe(reason);
    } finally {
      await reader.close();
    }
    await reader.close();
  },
);
