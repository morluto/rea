import { sha256 as digest } from "../../support/sha256.js";
import type { FileHandle } from "node:fs/promises";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createV8CodeCacheService } from "../../../src/composition/v8CodeCache.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { v8CodeCacheFixture } from "../../../src/v8/V8CodeCache.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const { selected } = vi.hoisted(() => ({
  selected: {
    opened: undefined as
      | ((path: unknown, file: FileHandle) => void)
      | undefined,
  },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args);
      selected.opened?.(args[0], file);
      return file;
    },
  };
});

afterEach(() => {
  selected.opened = undefined;
  vi.restoreAllMocks();
});

const prefixBytes = 65_536;
const fixture = () => {
  const bytes = Buffer.alloc(prefixBytes * 2 + 257);
  v8CodeCacheFixture().copy(bytes, 0, 0, 32);
  bytes.writeUInt32LE(bytes.length - 32, 20);
  bytes.write("terminal\tlabel", bytes.length - 14, "ascii");
  return bytes;
};

it.each([
  ["decoder EOF", "read-coverage"],
  ["file changed after decode read", "container-identity"],
] as const)(
  "retains only the physical V8 snapshot after %s",
  async (stage, integrityCheck) => {
    const root = await createTestTempDirectory("rea-v8-positional-");
    const path = join(root, "selected.jsc");
    const bytes = fixture();
    await writeFile(path, bytes);
    const handles: FileHandle[] = [];
    let affectedReads = 0;
    selected.opened = (openedPath, handle) => {
      if (String(openedPath) !== path) return;
      handles.push(handle);
      const file = handle as {
        read(
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ): Promise<{ bytesRead: number; buffer: Buffer }>;
      };
      const read = file.read.bind(file);
      vi.spyOn(file, "read").mockImplementation(
        async (buffer, offset, length, position) => {
          // The earlier fingerprint reads in 64 KiB chunks. This longer positional
          // request can only come from the payload scanner after hashing.
          if (position !== prefixBytes || length !== bytes.length - prefixBytes)
            return read(buffer, offset, length, position);
          affectedReads += 1;
          if (stage === "decoder EOF") return { bytesRead: 0, buffer };
          const acquired = await read(buffer, offset, length, position);
          await appendFile(path, "changed");
          return acquired;
        },
      );
    };
    const service = createV8CodeCacheService();
    try {
      const result = await service.inspect({ path });
      expect(affectedReads).toBe(1);
      expect(result).toMatchObject({
        ok: false,
        error: {
          _tag: "AnalysisArtifactChangedError",
          integrityCheck,
          cleanupIncomplete: false,
          partialObservation: {
            kind: "file-snapshot-hash",
            path,
            bytes: bytes.length,
            sha256: digest(bytes),
          },
        },
      });
      expect(handles.map((handle) => handle.fd)).toEqual([-1]);
    } finally {
      await service.close();
    }
  },
);

it.each([
  { stage: "denied close", block: true, cancel: false },
  { stage: "denied close with cancellation", block: true, cancel: true },
  { stage: "successful close with cancellation", block: false, cancel: true },
])("retains verified V8 Evidence during $stage", async ({ block, cancel }) => {
  const root = await createTestTempDirectory("rea-v8-finalization-");
  const path = join(root, "selected.jsc");
  const bytes = fixture();
  await writeFile(path, bytes);
  const controller = new AbortController();
  const reason = { stage: "V8 descriptor finalization" };
  const handles: FileHandle[] = [];
  let denyClose = block;
  selected.opened = (openedPath, file) => {
    if (String(openedPath) !== path) return;
    handles.push(file);
    const close = file.close.bind(file);
    vi.spyOn(file, "close").mockImplementation(async () => {
      if (cancel) controller.abort(reason);
      if (denyClose) throw new Error("injected V8 descriptor close failure");
      await close();
    });
  };
  const service = createV8CodeCacheService();
  try {
    const result = await service.inspect(
      { path, max_strings: 2, min_string_bytes: 8 },
      { signal: controller.signal },
    );
    if (result.ok)
      throw new Error("Expected descriptor finalization to interrupt success");
    const { error } = result;
    expect(error.cleanupIncomplete).toBe(block);
    expect(error.cleanupResources).toEqual(block ? [path] : []);
    const cancellation = block ? error.cleanupPrimary : error;
    if (cancel) {
      expect(cancellation?._tag).toBe("AnalysisCancelledError");
      expect(cancellation?.cause).toBe(reason);
    }
    expect(handles).toHaveLength(1);
    if (block) expect(handles[0]?.fd).toBeGreaterThanOrEqual(0);
    else expect(handles[0]?.fd).toBe(-1);
    const evidence = parseEvidence(error.partialObservation);
    expect(evidence).toMatchObject({
      operation: "inspect_v8_code_cache",
      parameters: { path, max_strings: 2, min_string_bytes: 8 },
      normalized_result: {
        artifact: { path, sha256: digest(bytes), bytes: bytes.length },
        payload: {
          offset: 32,
          bytes: bytes.length - 32,
          sha256: digest(bytes.subarray(32)),
        },
        embedded_strings: [
          {
            offset: bytes.length - 14,
            bytes: 14,
            retained_bytes: 14,
            truncated: false,
            text: "terminal\tlabel",
          },
        ],
        coverage: {
          status: "complete",
          scanned_bytes: bytes.length - 32,
          strings: 1,
        },
      },
      locations: [
        { kind: "artifact-path", path },
        { kind: "file-offset-range", start: 32, end: bytes.length },
      ],
    });
    if (block) {
      await expect(service.close()).rejects.toMatchObject({
        cleanupIncomplete: true,
        cleanupResources: [path],
      });
    }
    denyClose = false;
    await service.close();
    expect(handles.map((handle) => handle.fd)).toEqual([-1]);
    expect(error.cleanupIncomplete).toBe(false);
    expect(error.cleanupResources).toEqual([]);
    expect(error.partialObservation).toEqual(evidence);
  } finally {
    denyClose = false;
    await service.close();
  }
});

it("omits required_value on details.limit when a file grows past max_file_bytes during reading", async () => {
  const root = await createTestTempDirectory("rea-v8-growth-");
  const path = join(root, "growing.jsc");
  const bytes = v8CodeCacheFixture("function g(){ return 7; } g();");
  await writeFile(path, bytes);
  let grew = false;
  selected.opened = (openedPath, handle) => {
    if (String(openedPath) !== path) return;
    const file = handle as {
      read(
        buffer: Buffer,
        offset: number,
        length: number,
        position: number | null,
      ): Promise<{ bytesRead: number; buffer: Buffer }>;
    };
    const read = file.read.bind(file);
    vi.spyOn(file, "read").mockImplementation(
      async (buffer, offset, length, position) => {
        if (!grew) {
          grew = true;
          await appendFile(path, "!");
        }
        return read(buffer, offset, length, position);
      },
    );
  };
  const service = createV8CodeCacheService();
  try {
    const result = await service.inspect({
      path,
      max_file_bytes: bytes.length,
    });
    expect(grew).toBe(true);
    if (result.ok) throw new Error("Expected file-growth byte-budget refusal");
    expect(result.error).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
      resource: "file-size",
      limit: {
        control_kind: "parameter",
        parameter: "max_file_bytes",
        effective_value: bytes.length,
        unit: "bytes",
        minimum: 36,
        maximum: 67_108_864,
        default_value: 33_554_432,
        applies_at: "next_call",
      },
    });
    expect(result.error.limit).not.toHaveProperty("required_value");
  } finally {
    await service.close();
  }
});
