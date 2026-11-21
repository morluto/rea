import { createHash } from "node:crypto";
import { open, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { SelectedRasterSnapshotReader } from "./SelectedRasterSnapshotReader.js";

it("returns a bounded snapshot with whole-file hash after releasing source ownership", async () => {
  const root = await createTestTempDirectory("rea-raster-snapshot-");
  const path = join(root, "source");
  const bytes = Buffer.from([1, 2, 3, 4, 5]);
  await writeFile(path, bytes);
  let closed = false;
  const reader = new SelectedRasterSnapshotReader({
    stat,
    open: async (...args: Parameters<typeof open>) => {
      const file = await open(...args);
      const close = file.close.bind(file);
      Object.defineProperty(file, "close", {
        value: async () => {
          await close();
          closed = true;
        },
      });
      return file;
    },
  });
  try {
    const result = await reader.read(
      { path, offset: 1, length: 3 },
      "inspect_structured_raster_candidates",
      (snapshot) => snapshot,
    );
    if (!result.ok) throw result.error;
    expect(closed).toBe(true);
    expect([...result.value.bytes]).toEqual([2, 3, 4]);
    expect(result.value.artifact.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(result.value.window).toEqual({ offset: 1, length: 3 });
  } finally {
    await reader.close();
  }
});

it.each([false, true])(
  "retains checked identity and primary parser error with close failure=%s",
  async (failClose) => {
    const root = await createTestTempDirectory("rea-identity-failure-");
    const path = join(root, "source");
    const bytes = Buffer.from([1, 2, 3, 4, 5]);
    await writeFile(path, bytes);
    const { AnalysisInputError } =
      await import("../../domain/analysisErrorCore.js");
    const primary = new AnalysisInputError(
      "inspect_structured_raster_candidates",
      undefined,
      [
        {
          path: ["profile"],
          reason: "invalid_value",
          message: "Malformed parser input",
        },
      ],
    );
    let closes = 0;
    const reader = new SelectedRasterSnapshotReader({
      stat,
      open: async (...args: Parameters<typeof open>) => {
        const file = await open(...args),
          close = file.close.bind(file);
        Object.defineProperty(file, "close", {
          value: async () => {
            closes++;
            if (failClose && closes === 1) throw Error("close failed");
            await close();
          },
        });
        return file;
      },
    });
    try {
      const result = await reader.read(
        { path, offset: 1, length: 2 },
        "inspect_structured_raster_candidates",
        () => {
          throw primary;
        },
      );
      if (result.ok) throw Error("Expected parser failure");
      expect(result.error.partialObservation).toEqual({
        kind: "file-snapshot-hash",
        path,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      if (!failClose) expect(result.error).toBe(primary);
      else {
        expect(result.error.cause).toBeInstanceOf(AggregateError);
        expect((result.error.cause as AggregateError).errors[0]).toBe(primary);
        expect(result.error.cleanupIncomplete).toBe(true);
        await reader.close();
        expect(result.error.cleanupIncomplete).toBe(false);
      }
    } finally {
      await reader.close();
    }
  },
);

it.each([false, true])(
  "retains acquired identity on cancellation with close failure=%s",
  async (failClose) => {
    const root = await createTestTempDirectory("rea-identity-cancel-");
    const path = join(root, "source"),
      bytes = Buffer.from([1, 2, 3]);
    await writeFile(path, bytes);
    const controller = new AbortController();
    const { assertArtifactReadActive } =
      await import("../../resources/index.js");
    let closes = 0;
    const reader = new SelectedRasterSnapshotReader({
      stat,
      open: async (...args: Parameters<typeof open>) => {
        const file = await open(...args),
          close = file.close.bind(file);
        Object.defineProperty(file, "close", {
          value: async () => {
            closes++;
            if (failClose && closes === 1) throw Error("close failed");
            await close();
          },
        });
        return file;
      },
    });
    try {
      const result = await reader.read(
        { path, offset: 0 },
        "inspect_structured_raster_candidates",
        () => {
          controller.abort("stop");
          assertArtifactReadActive(controller.signal);
        },
        { signal: controller.signal },
      );
      if (result.ok) throw Error("Expected cancellation");
      expect(result.error._tag).toBe("AnalysisCancelledError");
      expect(result.error.partialObservation).toEqual({
        kind: "file-snapshot-hash",
        path,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      expect(result.error.cleanupIncomplete).toBe(failClose);
      await reader.close();
      expect(result.error.cleanupIncomplete).toBe(false);
    } finally {
      await reader.close();
    }
  },
);

it("does not publish a hash before final identity validation", async () => {
  const root = await createTestTempDirectory("rea-identity-changed-");
  const path = join(root, "source");
  await writeFile(path, Buffer.from([1, 2, 3]));
  let stats = 0,
    consumed = false;
  const reader = new SelectedRasterSnapshotReader({
    open,
    stat: (async (...args: Parameters<typeof stat>) => {
      if (++stats === 2) await writeFile(path, Buffer.from([4, 5, 6, 7]));
      return stat(...args);
    }) as typeof stat,
  });
  try {
    const result = await reader.read(
      { path, offset: 0 },
      "inspect_structured_raster_candidates",
      () => {
        consumed = true;
      },
    );
    if (result.ok) throw Error("Expected changed source failure");
    expect(result.error._tag).toBe("AnalysisArtifactChangedError");
    expect(result.error.partialObservation).toBeUndefined();
    expect(consumed).toBe(false);
  } finally {
    await reader.close();
  }
});

it("retains identity when closing a completed acquisition without an observation projector fails", async () => {
  const root = await createTestTempDirectory("rea-identity-close-");
  const path = join(root, "source"),
    bytes = Buffer.from([1, 2, 3]);
  await writeFile(path, bytes);
  let closes = 0;
  const reader = new SelectedRasterSnapshotReader({
    stat,
    open: async (...args: Parameters<typeof open>) => {
      const file = await open(...args),
        close = file.close.bind(file);
      Object.defineProperty(file, "close", {
        value: async () => {
          if (++closes === 1) throw Error("close failed");
          await close();
        },
      });
      return file;
    },
  });
  try {
    const result = await reader.read(
      { path, offset: 1, length: 1 },
      "export_structured_raster_resources",
      (s) => s,
    );
    if (result.ok) throw Error("Expected close failure");
    expect(result.error._tag).toBe("AnalysisOutputError");
    expect(result.error.partialObservation).toEqual({
      kind: "file-snapshot-hash",
      path,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(result.error.cleanupIncomplete).toBe(true);
    await reader.close();
    expect(result.error.cleanupIncomplete).toBe(false);
  } finally {
    await reader.close();
  }
});

it.each(["reading", "verified"] as const)(
  "retains identity only after verification when cancelled while %s",
  async (phase) => {
    const root = await createTestTempDirectory("rea-identity-phase-");
    const path = join(root, "source"),
      bytes = Buffer.from([1, 2, 3]);
    await writeFile(path, bytes);
    const controller = new AbortController();
    let stats = 0,
      consumed = false;
    const reader = new SelectedRasterSnapshotReader({
      stat: (async (...args: Parameters<typeof stat>) => {
        const value = await stat(...args);
        if (++stats === 2 && phase === "verified") controller.abort();
        return value;
      }) as typeof stat,
      open: async (...args: Parameters<typeof open>) => {
        const file = await open(...args),
          read = file.read.bind(file);
        Object.defineProperty(file, "read", {
          value: async (
            buffer: Buffer,
            offset: number,
            length: number,
            position: number,
          ) => {
            if (phase === "reading") controller.abort();
            return read(buffer, offset, Math.min(1, length), position);
          },
        });
        return file;
      },
    });
    try {
      const result = await reader.read(
        { path, offset: 0 },
        "inspect_structured_raster_candidates",
        () => {
          consumed = true;
        },
        { signal: controller.signal },
      );
      if (result.ok) throw Error("Expected cancellation");
      expect(result.error._tag).toBe("AnalysisCancelledError");
      expect(consumed).toBe(false);
      if (phase === "reading")
        expect(result.error.partialObservation).toBeUndefined();
      else
        expect(result.error.partialObservation).toEqual({
          kind: "file-snapshot-hash",
          path,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
    } finally {
      await reader.close();
    }
  },
);
