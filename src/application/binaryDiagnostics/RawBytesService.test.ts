import { open, stat, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import {
  inspectRawBytesSchema,
  searchRawBytesSchema,
} from "../../domain/native/rawBytes.js";
import {
  RawBytesService,
  RAW_BYTES_SCAN_CHUNK_BYTES,
} from "./RawBytesService.js";

const PE_SIGNATURE = [0x50, 0x45, 0x00, 0x00];
const PE_HEADER_TAIL = [
  0x64, 0x86, 0x06, 0x00, 0x6c, 0x7d, 0xe9, 0x6a, 0x00, 0x00, 0x00, 0x00,
];

const fileWith = async (
  prefix: string,
  size: number,
  patches: readonly (readonly [number, readonly number[]])[],
  fill = 0xaa,
): Promise<string> => {
  const root = await createTestTempDirectory(prefix);
  const path = join(root, "data.bin");
  const bytes = Buffer.alloc(size, fill);
  for (const [offset, patch] of patches) Buffer.from(patch).copy(bytes, offset);
  await writeFile(path, bytes);
  return path;
};

const searchResult = async (
  service: RawBytesService,
  input: Record<string, unknown>,
) => {
  const result = await service.search(input);
  if (!result.ok) throw result.error;
  return searchRawBytesSchema.parse(result.value.normalized_result);
};

/** A service whose every filesystem touch is recorded. */
const spiedService = () => {
  const stat = vi.fn(() => Promise.reject(new Error("must not stat")));
  const open = vi.fn(() => Promise.reject(new Error("must not open")));
  return {
    stat,
    open,
    service: new RawBytesService({ stat, open } as never),
  };
};

it("finds a signature at its mutually exact raw file offset", async () => {
  const path = await fileWith("rea-raw-sig-", 256, [
    [0x78, [...PE_SIGNATURE, ...PE_HEADER_TAIL]],
  ]);
  const service = new RawBytesService();
  try {
    const report = await searchResult(service, {
      path,
      pattern: "50 45 00 00",
    });
    expect(report.matches.map(({ offset }) => offset)).toEqual([0x78]);
    expect(report.matches[0]?.offset).toBe(120);
    expect(report.complete).toBe(true);
    expect(report.next_offset).toBeNull();
    expect(report.artifact).toEqual({ path, bytes: 256 });
    expect(report.matches[0]?.context).toBe(
      "00000070: aaaa aaaa aaaa aaaa 5045 0000 6486 0600  ........PE..d...",
    );
  } finally {
    await service.close();
  }
});

it("reports surrounding hex lines at their absolute offsets", async () => {
  const path = await fileWith("rea-raw-ctx-", 256, [
    [0x78, [...PE_SIGNATURE, ...PE_HEADER_TAIL]],
  ]);
  const service = new RawBytesService();
  try {
    const report = await searchResult(service, {
      path,
      pattern: "50 45 00 00",
      context_lines: 1,
    });
    const lines = report.matches[0]!.context.split("\n");
    expect(lines.map((line) => line.slice(0, 8))).toEqual([
      "00000060",
      "00000070",
      "00000080",
    ]);
    expect(lines[1]).toBe(
      "00000070: aaaa aaaa aaaa aaaa 5045 0000 6486 0600  ........PE..d...",
    );
    // The window is clamped at the file start rather than reading before offset 0.
    const first = await searchResult(service, {
      path,
      pattern: "aa aa",
      max_matches: 1,
      context_lines: 3,
    });
    expect(first.matches[0]?.context.split("\n")[0]?.slice(0, 8)).toBe(
      "00000000",
    );
  } finally {
    await service.close();
  }
});

it("matches a masked RIFF/WAVE header and rejects an unmasked wrong value", async () => {
  const header = [
    ...Buffer.from("RIFF"),
    0x24,
    0x10,
    0xe3,
    0x00,
    ...Buffer.from("WAVE"),
  ];
  const path = await fileWith("rea-raw-mask-", 128, [[5, header]], 0x11);
  const service = new RawBytesService();
  try {
    const wildcards = await searchResult(service, {
      path,
      pattern: "52494646 ???????? 57415645",
    });
    expect(wildcards.matches.map(({ offset }) => offset)).toEqual([5]);
    const masked = await searchResult(service, {
      path,
      pattern: "52494646 00000000 57415645",
      mask: "ffffffff 00000000 ffffffff",
    });
    expect(masked.matches.map(({ offset }) => offset)).toEqual([5]);
    const unmasked = await searchResult(service, {
      path,
      pattern: "52494646 00000000 57415645",
    });
    expect(unmasked.matches).toEqual([]);
    expect(unmasked.complete).toBe(true);
    const wrongValue = await searchResult(service, {
      path,
      pattern: "52494646 ???????? 57415646",
      mask: "ffffffff 00000000 ffffffff",
    });
    expect(wrongValue.matches).toEqual([]);
    const nibble = await searchResult(service, {
      path,
      pattern: "5f",
      mask: "f0",
      max_matches: 1,
    });
    expect(nibble.matches.map(({ offset }) => offset)).toEqual([5]);
  } finally {
    await service.close();
  }
});

it.each([
  ["a match straddling the first chunk boundary", 3],
  ["a match ending exactly on the chunk boundary", 8],
  ["a match starting exactly on the chunk boundary", 0],
])("finds %s", async (_name, before) => {
  const chunk = RAW_BYTES_SCAN_CHUNK_BYTES;
  const needle = [0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04];
  const first = chunk - before;
  const second = 2 * chunk - before - 1;
  const path = await fileWith("rea-raw-chunk-", 2 * chunk + 100, [
    [first, needle],
    [second, needle],
  ]);
  const service = new RawBytesService();
  try {
    const report = await searchResult(service, {
      path,
      pattern: "de ad be ef 01 02 03 04",
      max_matches: 10,
    });
    expect(report.matches.map(({ offset }) => offset)).toEqual([first, second]);
  } finally {
    await service.close();
  }
});

it("finds boundary matches however the operating system splits physical reads", async () => {
  const needle = [0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04];
  const offsets = [0, 3571 - 2, 5000, 2 * 3571 - 7, 70_000];
  const path = await fileWith(
    "rea-raw-short-",
    80_000,
    offsets.map((offset) => [offset, needle] as const),
  );
  const service = new RawBytesService({
    stat,
    open: async (...args) => {
      const file = await open(...args);
      const read = file.read.bind(file);
      Object.defineProperty(file, "read", {
        value: async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) => read(buffer, offset, Math.min(length, 3571), position),
      });
      return file;
    },
  });
  try {
    const report = await searchResult(service, {
      path,
      pattern: "de ad be ef 01 02 03 04",
      max_matches: 10,
    });
    expect(report.matches.map(({ offset }) => offset)).toEqual(offsets);
  } finally {
    await service.close();
  }
});

it("reports overlapping matches and pages with start_offset when truncated", async () => {
  const path = await fileWith("rea-raw-page-", 64, [], 0x00);
  const service = new RawBytesService();
  try {
    const page = await searchResult(service, {
      path,
      pattern: "00 00",
      max_matches: 3,
    });
    expect(page.matches.map(({ offset }) => offset)).toEqual([0, 1, 2]);
    expect(page.complete).toBe(false);
    expect(page.next_offset).toBe(3);
    const rest = await searchResult(service, {
      path,
      pattern: "00 00",
      max_matches: 1000,
      start_offset: page.next_offset,
    });
    expect(rest.matches).toHaveLength(60);
    expect(rest.matches[0]?.offset).toBe(3);
    expect(rest.complete).toBe(true);
    const exact = await searchResult(service, {
      path,
      pattern: "00 00",
      max_matches: 63,
    });
    expect(exact.matches).toHaveLength(63);
    expect(exact.complete).toBe(true);
    expect(exact.next_offset).toBeNull();
  } finally {
    await service.close();
  }
});

it("returns the exact bytes and the xxd dump for a known window", async () => {
  const path = await fileWith("rea-raw-read-", 256, [
    [0x78, [...PE_SIGNATURE, ...PE_HEADER_TAIL]],
  ]);
  const service = new RawBytesService();
  try {
    const result = await service.inspect({ path, offset: 0x78, length: 16 });
    if (!result.ok) throw result.error;
    const report = inspectRawBytesSchema.parse(result.value.normalized_result);
    expect(report.hex_dump).toBe(
      "00000078: 5045 0000 6486 0600 6c7d e96a 0000 0000  PE..d...l}.j....",
    );
    expect(report.data_hex).toBe("50450000648606006c7de96a00000000");
    expect(report.window).toEqual({ offset: 0x78, length: 16 });
    expect(report.artifact).toEqual({ path, bytes: 256 });
    expect(result.value.operation).toBe("inspect_raw_bytes");
    expect(result.value.confidence).toBe("observed");
    expect(result.value.provider.id).toBe("raw-bytes");
    // A window ending exactly at EOF is allowed.
    const tail = await service.inspect({ path, offset: 250, length: 6 });
    if (!tail.ok) throw tail.error;
    expect(
      inspectRawBytesSchema.parse(tail.value.normalized_result).data_hex,
    ).toBe("aa".repeat(6));
  } finally {
    await service.close();
  }
});

it("rejects a window beyond the end of the file with an explicit error, never a short result", async () => {
  const path = await fileWith("rea-raw-eof-", 256, []);
  const service = new RawBytesService();
  try {
    for (const input of [
      { path, offset: 250, length: 10 },
      { path, offset: 256, length: 1 },
      { path, offset: 4000, length: 1 },
    ]) {
      const result = await service.inspect(input);
      expect(result).toMatchObject({
        ok: false,
        error: { _tag: "AnalysisInputError" },
      });
      if (result.ok) throw new Error("expected failure");
      expect(result.error).toMatchObject({
        issues: [
          {
            message: expect.stringMatching(/beyond the end of the file/u),
          },
        ],
      });
    }
    const search = await service.search({
      path,
      pattern: "aa",
      start_offset: 257,
    });
    expect(search).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisInputError" },
    });
  } finally {
    await service.close();
  }
});

it("rejects an oversized read and an unconstrained pattern before touching the filesystem", async () => {
  const { service, stat, open } = spiedService();
  const path = join(process.platform === "win32" ? "C:\\" : "/", "nothing");
  const cases = [
    () => service.inspect({ path, offset: 0, length: 4097 }),
    () => service.inspect({ path, offset: 0, length: 0 }),
    () => service.search({ path, pattern: "?? ?? ??" }),
    () => service.search({ path, pattern: "50 45", mask: "00 00" }),
    () => service.search({ path, pattern: "50 45", max_matches: 1001 }),
  ];
  for (const run of cases) {
    const result = await run();
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisInputError" },
    });
  }
  expect(stat).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});

it("rejects relative paths, missing files and directories as input errors", async () => {
  const path = await fileWith("rea-raw-input-", 8, []);
  const service = new RawBytesService();
  try {
    for (const input of [
      { path: "relative.bin", offset: 0, length: 1 },
      { path: `${path}.missing`, offset: 0, length: 1 },
      { path: join(path, ".."), offset: 0, length: 1 },
    ])
      expect(await service.inspect(input)).toMatchObject({
        ok: false,
        error: { _tag: "AnalysisInputError" },
      });
  } finally {
    await service.close();
  }
});

it("honors cancellation before admission and during the scan", async () => {
  const path = await fileWith("rea-raw-cancel-", 1024 * 1024, []);
  const reason = { request: "opaque cancellation" };
  const service = new RawBytesService();
  const before = await service.search(
    { path, pattern: "00" },
    { signal: AbortSignal.abort(reason) },
  );
  if (before.ok) throw new Error("expected cancellation");
  expect(before.error).toMatchObject({ _tag: "AnalysisCancelledError" });
  expect(before.error.cause).toBe(reason);
  const controller = new AbortController();
  const streaming = new RawBytesService({
    stat,
    open: async (...args) => {
      const file = await open(...args);
      const read = file.read.bind(file);
      vi.spyOn(file, "read").mockImplementation(async (...readArgs) => {
        const result = await read(...readArgs);
        controller.abort(reason);
        return result;
      });
      return file;
    },
  });
  const during = await streaming.search(
    { path, pattern: "ff", max_matches: 5 },
    { signal: controller.signal },
  );
  if (during.ok) throw new Error("expected cancellation");
  expect(during.error).toMatchObject({ _tag: "AnalysisCancelledError" });
  expect(during.error.cause).toBe(reason);
});

it("reports a changed artifact when the file grows between admission and the read", async () => {
  const path = await fileWith("rea-raw-changed-", 256, []);
  const service = new RawBytesService({
    stat,
    open: async (...args) => {
      const file = await open(...args);
      await appendFile(path, Buffer.from([1, 2, 3]));
      return file;
    },
  });
  const result = await service.inspect({ path, offset: 0, length: 16 });
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisArtifactChangedError" },
  });
});

const BOUNDARY_NEEDLE = [0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04];

it.each([
  // Whole-byte first constraint: the indexOf-anchored scan path.
  ["exact", 4, "de ad be ef", undefined],
  ["exact", 8, "de ad be ef 01 02 03 04", undefined],
  // Partial first byte: the byte-by-byte scan path.
  ["partial-first-byte", 4, "d0 ad be ef", "f0 ff ff ff"],
  [
    "partial-first-byte",
    8,
    "d0 ad be ef 01 02 03 04",
    "f0 ff ff ff ff ff ff ff",
  ],
])(
  "finds a %s %i-byte match at every start position around the chunk boundary",
  async (_mode, length, pattern, mask) => {
    const chunk = RAW_BYTES_SCAN_CHUNK_BYTES;
    const needle = BOUNDARY_NEEDLE.slice(0, length);
    const root = await createTestTempDirectory("rea-raw-sweep-");
    const path = join(root, "data.bin");
    const service = new RawBytesService();
    try {
      // From wholly before the boundary (start = chunk - length) through the
      // first start that lies wholly after it (start = chunk). The carried
      // overlap must be exactly length - 1 bytes: one fewer loses the match
      // that starts at chunk - (length - 1).
      for (let start = chunk - length; start <= chunk; start += 1) {
        const bytes = Buffer.alloc(2 * chunk + 64, 0xaa);
        Buffer.from(needle).copy(bytes, start);
        await writeFile(path, bytes);
        const report = await searchResult(service, {
          path,
          pattern,
          ...(mask === undefined ? {} : { mask }),
        });
        expect(
          report.matches.map(({ offset }) => offset),
          `needle at ${String(start)} (chunk - ${String(chunk - start)})`,
        ).toEqual([start]);
      }
    } finally {
      await service.close();
    }
  },
);

it("discloses the zero-size limitation when searching an empty file", async () => {
  const root = await createTestTempDirectory("rea-raw-zero-");
  const path = join(root, "empty.bin");
  await writeFile(path, Buffer.alloc(0));
  const service = new RawBytesService();
  try {
    const report = await searchResult(service, { path, pattern: "50 45" });
    expect(report.matches).toEqual([]);
    expect(report.complete).toBe(true);
    expect(report.limitations).toContainEqual(
      expect.stringMatching(
        /The file reports a size of 0, so no bytes were read/,
      ),
    );
  } finally {
    await service.close();
  }
});

it("anchors on an exact byte when the first byte is only partially masked", async () => {
  const root = await createTestTempDirectory("rea-raw-partial-exact-");
  const path = join(root, "data.bin");
  const bytes = Buffer.alloc(512, 0x00);
  bytes[100] = 0xd0;
  bytes[101] = 0x42;
  await writeFile(path, bytes);
  const service = new RawBytesService();
  try {
    const report = await searchResult(service, {
      path,
      pattern: "d0 42",
      mask: "f0 ff",
    });
    expect(report.matches.map(({ offset }) => offset)).toEqual([100]);
  } finally {
    await service.close();
  }
});

describe.each([
  {
    operation: "inspect" as const,
    call: (service: RawBytesService, path: string, opts?: any) =>
      service.inspect({ path, offset: 0, length: 16 }, opts),
    opName: "inspect_raw_bytes",
  },
  {
    operation: "search" as const,
    call: (service: RawBytesService, path: string, opts?: any) =>
      service.search({ path, pattern: "00", max_matches: 10 }, opts),
    opName: "search_raw_bytes",
  },
])("lifecycle suite for $operation", ({ operation, call, opName }) => {
  it.each([false, true])(
    "retains completed Evidence when final close is cancelled (close fails: %s)",
    async (closeFails) => {
      const root = await createTestTempDirectory(
        `rea-raw-${operation}-final-cancel-`,
      );
      const path = join(root, "bytes.bin");
      await writeFile(path, Buffer.alloc(128, 0xaa));
      const controller = new AbortController();
      const reason = new Error("cancelled during close");
      const closeFailure = new Error("injected close failure");
      let failClose = closeFails;
      let closes = 0;
      const service = new RawBytesService({
        stat,
        open: async (...args) => {
          const file = await open(...args);
          const close = file.close.bind(file);
          vi.spyOn(file, "close").mockImplementation(async () => {
            closes += 1;
            controller.abort(reason);
            if (failClose) throw closeFailure;
            await close();
          });
          return file;
        },
      });

      const result = await call(service, path, { signal: controller.signal });
      if (result.ok)
        throw new Error("Expected cancellation during finalization");
      expect(result.error).toMatchObject({
        _tag: "AnalysisCancelledError",
        cleanupIncomplete: closeFails,
      });
      expect(result.error.cause).toBe(reason);
      const evidence = result.error.partialObservation;
      expect(evidence).toMatchObject({
        operation: opName,
        normalized_result: { artifact: { path } },
      });
      expect(closes).toBe(1);
      if (closeFails) {
        expect(result.error.secondaryFailures).toMatchObject([
          { _tag: "AnalysisOutputError", cleanupIncomplete: true },
        ]);
      } else {
        expect(result.error.secondaryFailures).toEqual([]);
      }
      failClose = false;
      await service.close();
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(result.error.partialObservation).toBe(evidence);
      expect(closes).toBe(closeFails ? 2 : 1);
    },
  );

  it("retains a failed descriptor close and retries it before opening another file", async () => {
    const root = await createTestTempDirectory(
      `rea-raw-${operation}-close-retry-`,
    );
    const path = join(root, "bytes.bin");
    await writeFile(path, Buffer.alloc(128, 0xaa));
    let failClose = true;
    let opens = 0;
    const service = new RawBytesService({
      stat,
      open: async (...args) => {
        opens += 1;
        const file = await open(...args);
        const close = file.close.bind(file);
        vi.spyOn(file, "close").mockImplementation(async () => {
          if (failClose) throw new Error("injected close failure");
          await close();
        });
        return file;
      },
    });

    const first = await call(service, path);
    if (first.ok) throw new Error("Expected the first close to fail");
    expect(first.error).toMatchObject({
      _tag: "AnalysisOutputError",
      cleanupIncomplete: true,
    });
    const observation = first.error.partialObservation;
    expect(observation).toMatchObject({
      operation: opName,
      normalized_result: { artifact: { path } },
    });
    expect(opens).toBe(1);

    const retryDenied = await call(service, path);
    expect(retryDenied).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisOutputError", cleanupIncomplete: true },
    });
    expect(opens).toBe(1);

    failClose = false;
    const recovered = await call(service, path);
    expect(recovered.ok).toBe(true);
    expect(first.error.cleanupIncomplete).toBe(false);
    expect(first.error.partialObservation).toBe(observation);
    expect(opens).toBe(2);
    await service.close();
  });

  it("preserves a primary read failure through failed close and resolves it on retry", async () => {
    const root = await createTestTempDirectory(
      `rea-raw-${operation}-read-close-`,
    );
    const path = join(root, "bytes.bin");
    await writeFile(path, Buffer.alloc(128, 0xaa));
    const readFailure = new Error("injected read failure");
    let failClose = true;
    let failRead = true;
    const service = new RawBytesService({
      stat,
      open: async (...args) => {
        const file = await open(...args);
        const read = file.read.bind(file);
        const close = file.close.bind(file);
        vi.spyOn(file, "read").mockImplementation(async (...readArgs) => {
          if (failRead) throw readFailure;
          return await read(...readArgs);
        });
        vi.spyOn(file, "close").mockImplementation(async () => {
          if (failClose) throw new Error("injected close failure");
          await close();
        });
        return file;
      },
    });

    const first = await call(service, path);
    if (first.ok) throw new Error("Expected the read and close to fail");
    expect(first.error).toMatchObject({
      cleanupIncomplete: true,
      cleanupPrimary: { _tag: "AnalysisOutputError" },
    });
    expect(first.error.cleanupPrimary?.cause).toBe(readFailure);

    failClose = false;
    failRead = false;
    const recovered = await call(service, path);
    expect(recovered.ok).toBe(true);
    expect(first.error.cleanupIncomplete).toBe(false);
    await service.close();
  });
});
