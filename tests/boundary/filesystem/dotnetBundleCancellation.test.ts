import { once } from "node:events";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { randomBytes } from "node:crypto";
import { createInflateRaw } from "node:zlib";
import { expect, it, vi } from "vitest";
import { DotnetBundleArtifactReader } from "../../../src/artifacts/DotnetBundleArtifactReader.js";
import { dotnetBundleFixture } from "../../../src/artifacts/dotnet/DotnetBundle.fixture.js";
import { createDeferred } from "../../fixtures/binarySession.js";
import { awaitAcknowledgement } from "../../fixtures/lifecycleAcknowledgement.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

vi.mock("node:zlib", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:zlib")>();
  return { ...original, createInflateRaw: vi.fn(original.createInflateRaw) };
});

const cases = [false, true].flatMap((compressed) =>
  (["unstarted", "backpressured"] as const).flatMap((phase) =>
    (["null", "object"] as const).map((reasonKind) => ({
      compressed,
      phase,
      reasonKind,
    })),
  ),
);

it("retains cancellation before decoder cleanup while compressed input is pending", async () => {
  const root = await createTestTempDirectory("rea-dotnet-decoder-cancel-");
  const path = join(root, "host.exe");
  await writeFile(
    path,
    dotnetBundleFixture([
      { path: "member", bytes: randomBytes(256 * 1024), compressed: true },
    ]).bytes,
  );
  const handle = await open(path, "r");
  const reader = new DotnetBundleArtifactReader(path, {
    handle,
    initial: await handle.stat(),
  });
  const started = createDeferred<void>();
  const pending = createDeferred<void>();
  let restore = () => {};
  let retire = async () => {};
  try {
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    expect(entries[0]?.compressedSize).toBeGreaterThan(64 * 1024);
    const controller = new AbortController();
    const output = await reader.open(entries[0]!, controller.signal);
    const settled = finished(output).catch((cause: unknown) => cause);
    retire = async () => {
      output.destroy();
      await settled;
    };
    const originalRead = handle.read.bind(handle);
    const spy = vi
      .spyOn(handle, "read")
      .mockImplementationOnce(originalRead)
      .mockImplementationOnce(async (...args) => {
        started.resolve();
        await pending.promise;
        return originalRead(...args);
      });
    restore = () => spy.mockRestore();
    const ready = once(output, "readable");
    output.read(0);
    await awaitAcknowledgement(
      ready.then(() => undefined),
      settled,
      "member readable",
    );
    await awaitAcknowledgement(
      started.promise,
      settled,
      "descriptor read started",
    );
    // The factory is a pass-through spy: observe genuine native decoder bytes.
    const created = vi.mocked(createInflateRaw).mock.results.at(-1);
    if (created?.type !== "return") throw new Error("Missing native decoder");
    const decoder = created.value;
    while (decoder.readableLength === 0)
      await awaitAcknowledgement(
        once(decoder, "readable").then(() => undefined),
        settled,
        "decoder readable",
      );
    expect(decoder.destroyed).toBe(false);
    const closed = new Promise<void>((resolve) =>
      decoder.once("close", () => resolve()),
    );
    const decoderSettled = finished(decoder).catch((cause: unknown) => cause);
    const reason = { stop: "compressed prefetch" };
    controller.abort(reason);
    output.resume();
    await awaitAcknowledgement(closed, decoderSettled, "decoder closed");
    pending.resolve();
    const failure = await settled;
    expect(failure).toMatchObject({ reason: "cancelled", cause: reason });
    expect((failure as Error).cause).toBe(reason);
  } finally {
    pending.resolve();
    await retire();
    await reader.close();
    restore();
    await handle.close();
  }
});

it.each([false, true])(
  "settles final descriptor validation before cancellation (fails: %s)",
  async (fails) => {
    const root = await createTestTempDirectory("rea-dotnet-final-validation-");
    const path = join(root, "host.exe");
    await writeFile(path, dotnetBundleFixture().bytes);
    const handle = await open(path, "r");
    const reader = new DotnetBundleArtifactReader(path, {
      handle,
      initial: await handle.stat(),
    });
    const started = createDeferred<void>();
    const pending = createDeferred<void>();
    const physical = Object.assign(new Error("final descriptor stat failure"), {
      code: "EIO",
    });
    let restore = () => {};
    let retire = async () => {};
    try {
      const entries = [];
      for await (const entry of reader.entries()) entries.push(entry);
      const controller = new AbortController();
      const output = await reader.open(entries[0]!, controller.signal);
      const settled = finished(output).catch((cause: unknown) => cause);
      retire = async () => {
        output.destroy();
        await settled;
      };
      const originalStat = handle.stat.bind(handle);
      const spy = vi
        .spyOn(handle, "stat")
        .mockImplementationOnce(async (...args) => {
          started.resolve();
          await pending.promise;
          if (fails) throw physical;
          return originalStat(...args);
        });
      restore = () => spy.mockRestore();
      output.resume();
      await awaitAcknowledgement(
        started.promise,
        settled,
        "final validation started",
      );
      const reason = { stop: "final validation" };
      controller.abort(reason);
      pending.resolve();
      const failure = await settled;
      expect(failure).toMatchObject({ reason: fails ? "io" : "cancelled" });
      expect((failure as Error).cause).toBe(fails ? physical : reason);
    } finally {
      pending.resolve();
      await retire();
      await reader.close();
      restore();
      await handle.close();
    }
  },
);

it.each([false, true])(
  "preserves a prefetched descriptor failure when a suspended consumer cancels (compressed: %s)",
  async (compressed) => {
    const root = await createTestTempDirectory("rea-dotnet-prefetch-cancel-");
    const path = join(root, "host.exe");
    await writeFile(
      path,
      dotnetBundleFixture([
        {
          path: "member",
          bytes: compressed
            ? randomBytes(256 * 1024)
            : Buffer.alloc(128 * 1024, 65),
          compressed,
        },
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
    let retire = async () => {};
    try {
      const entries = [];
      for await (const entry of reader.entries()) entries.push(entry);
      const controller = new AbortController();
      const output = await reader.open(entries[0]!, controller.signal);
      const settled = finished(output).catch((cause: unknown) => cause);
      retire = async () => {
        output.destroy();
        await settled;
      };
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
      await awaitAcknowledgement(
        ready.then(() => undefined),
        settled,
        "member readable",
      );
      await awaitAcknowledgement(
        started.promise,
        settled,
        "descriptor read started",
      );
      expect(output.readableLength).toBeGreaterThan(0);
      pending.resolve();
      controller.abort({ stop: "prefetch pending" });
      output.resume();
      const failure = await settled;
      expect(failure).toMatchObject({ reason: "io" });
      expect((failure as Error).cause).toBe(physical);
    } finally {
      pending.resolve();
      await retire();
      await reader.close();
      restore();
      await handle.close();
    }
  },
);

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
      const settled = finished(output).catch((cause: unknown) => cause);
      const errors: Error[] = [];
      output.on("error", (error) => errors.push(error));
      if (phase === "backpressured") {
        const ready = once(output, "readable");
        output.read(0);
        await awaitAcknowledgement(
          ready.then(() => undefined),
          settled,
          "idle member readable",
        );
        expect(output.readableLength).toBeGreaterThan(0);
      }
      const reason = reasonKind === "null" ? null : { stop: "idle member" };
      controller.abort(reason);
      // Cancellation must not require a consumer to resume the iterator first.
      expect(output.destroyed).toBe(true);
      expect(await settled).toMatchObject({
        reason: "cancelled",
      });
      expect(errors[0]?.cause).toBe(reason);
    } finally {
      await reader.close();
    }
    await reader.close();
  },
);
