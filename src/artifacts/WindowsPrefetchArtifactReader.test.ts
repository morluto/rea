import { expect, it, vi } from "vitest";
import { appendFile, truncate } from "node:fs/promises";

import { prefetchMetadataSchema } from "../domain/formatMetadata/androidAndSystemMetadata.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { openRegularFile } from "../filesystem/RegularFile.js";
import { WindowsPrefetchArtifactReader } from "./WindowsPrefetchArtifactReader.js";
import { ArtifactReaderFailure } from "../resources/ArtifactReader.js";
import { translateArtifactFailure } from "../resources/ArtifactOperationFailure.js";
import { ArtifactFileSource } from "../resources/ArtifactFileSource.js";
import { assertArtifactReadActive } from "../resources/ArtifactFileOperation.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";
import { awaitAcknowledgement } from "../../tests/fixtures/lifecycleAcknowledgement.js";
import { PREFETCH_HEADER_READ_BYTES } from "../domain/windows/prefetchFormat.js";
import { prefetchFixture, writePrefetch } from "./windows/Prefetch.fixture.js";

const PARSED_VERSIONS = ["17", "23"] as const;

const readerFor = async (
  bytes: Buffer,
): Promise<WindowsPrefetchArtifactReader> =>
  new WindowsPrefetchArtifactReader(
    await writePrefetch("GOOGLE.EXE-1.pf", bytes),
  );

const inventory = async (
  reader: WindowsPrefetchArtifactReader,
): Promise<string[]> => {
  const limitations: string[] = [];
  for await (const _entry of reader.entries(undefined, {
    onCoverage: (coverage) => {
      limitations.push(...coverage.limitations);
    },
  }))
    continue;
  return limitations;
};

it.each(PARSED_VERSIONS)(
  "reports the v%s header without enumerating members",
  async (version) => {
    const reader = await readerFor(prefetchFixture({ version }));
    try {
      expect((await inventory(reader)).length).toBeGreaterThan(0);
      expect(reader.formatMetadata()).toMatchObject({
        kind: "windows-prefetch",
        version,
        file_bytes: prefetchFixture({ version }).length,
        executable_name: "GOOGLE.EXE",
        executable_path_hash: "1a2b3c4d",
      });
    } finally {
      await reader.close();
    }
  },
);

it("reports the v23 run count and last-run presence as declared", async () => {
  const reader = await readerFor(
    prefetchFixture({ version: "23", runCount: 12 }),
  );
  try {
    await inventory(reader);
    expect(reader.formatMetadata()).toMatchObject({
      run_count: 12,
      run_time_slots: 1,
    });
  } finally {
    await reader.close();
  }
});

it("reports the v17 run count from its own offset", async () => {
  // v17 keeps the run count at 0x90; 0x98 is v23's offset. Write a decoy at
  // 0x98 so a reader that used v23's offset for v17 would report 99, not 7.
  const bytes = prefetchFixture({ version: "17", runCount: 7 });
  bytes.writeUInt32LE(99, 0x98);
  const reader = await readerFor(bytes);
  try {
    await inventory(reader);
    expect(reader.formatMetadata()).toMatchObject({
      run_count: 7,
      run_time_slots: 1,
    });
  } finally {
    await reader.close();
  }
});

it("names the undecoded fields in its one limitation", async () => {
  const reader = await readerFor(prefetchFixture({ version: "23" }));
  try {
    expect((await inventory(reader)).join(" ")).toContain("not decoded");
  } finally {
    await reader.close();
  }
});

it.each([
  ["v26", prefetchFixture({ version: "26" })],
  ["MAM", prefetchFixture({ version: "23", compressed: true }).subarray(0, 8)],
] as const)(
  "preserves the unsupported %s target in the public refusal",
  async (detail, bytes) => {
    const path = await writePrefetch("program.pf", bytes);
    const result = scanCanonicalArtifactInventory(path).catch(
      (cause: unknown) => {
        expect(cause).toMatchObject({
          message: expect.stringContaining(detail),
        });
        throw projectAnalysisError(
          translateArtifactFailure("inspect_artifact", path, cause),
        );
      },
    );
    await expect(result).rejects.toMatchObject({
      code: "unsupported_target",
      details: {
        path,
        failure_kind: "unsupported",
        format: "windows-prefetch",
      },
    });
  },
);

it("reads only the header and retains the size of a padded capture", async () => {
  const fixture = prefetchFixture({ version: "23" });
  const path = await writePrefetch("large.pf", fixture);
  const fileBytes = 64 * 1024 * 1024 + 1;
  await truncate(path, fileBytes);
  const admitted = await openRegularFile(path, { symlinks: "reject" });
  const reader = new WindowsPrefetchArtifactReader(path, admitted);
  const reads = vi.spyOn(admitted.handle, "read");
  try {
    await expect(inventory(reader)).resolves.toContain(
      `The header declares ${String(fixture.length)} bytes but the file holds ${String(fileBytes)}.`,
    );
    expect(prefetchMetadataSchema.parse(reader.formatMetadata())).toMatchObject(
      {
        file_bytes: fileBytes,
        declared_file_bytes: fixture.length,
        run_count: 7,
      },
    );
    expect(reads).toHaveBeenCalledWith(
      expect.any(Buffer),
      0,
      PREFETCH_HEADER_READ_BYTES,
      0,
    );
    for (const call of reads.mock.calls) {
      const [, , length, position] = call as unknown as [
        Buffer,
        number,
        number,
        number,
      ];
      expect(position + length).toBeLessThanOrEqual(PREFETCH_HEADER_READ_BYTES);
    }
  } finally {
    try {
      await reader.close();
    } finally {
      reads.mockRestore();
      await admitted.handle.close();
    }
  }
});

it("calls a truncated newer-generation capture truncated, not unsupported", async () => {
  const reader = await readerFor(
    prefetchFixture({ version: "26" }).subarray(0, 60),
  );
  try {
    await expect(inventory(reader)).rejects.toMatchObject({
      reason: "truncated",
      message: expect.stringContaining(
        "ends inside the Prefetch header",
      ) as unknown,
    });
  } finally {
    await reader.close();
  }
});

it("recognizes a checksum-bearing MAM header as the same container", async () => {
  // The wrapper sets the high bit of the compression byte when it records a
  // checksum; the low seven bits still select XPRESS Huffman, so this is the
  // same unsupported container rather than an unrecognized file.
  const reader = await readerFor(
    prefetchFixture({
      version: "23",
      compressed: true,
      checksum: true,
    }).subarray(0, 12),
  );
  try {
    await expect(inventory(reader)).rejects.toMatchObject({
      reason: "unsupported",
      message: expect.stringContaining("MAM") as unknown,
    });
  } finally {
    await reader.close();
  }
});

it("calls a file that ends inside the MAM header truncated, not unsupported", async () => {
  const reader = await readerFor(
    prefetchFixture({ version: "23", compressed: true }).subarray(0, 5),
  );
  try {
    await expect(inventory(reader)).rejects.toMatchObject({
      reason: "truncated",
      message: expect.stringContaining("MAM container header") as unknown,
    });
    expect(reader.formatMetadata()).toBeUndefined();
  } finally {
    await reader.close();
  }
});

it("does not read a MAM prefix without the container version byte as Prefetch", async () => {
  // A file whose first three bytes spell "MAM" carries no container header, so
  // the three letters alone must not give it Prefetch provenance.
  const bytes = prefetchFixture({ version: "23", compressed: true });
  bytes[3] = 0;
  const snapshot = await scanCanonicalArtifactInventory(
    await writePrefetch("MAM-prefixed.bin", bytes),
  );
  expect(snapshot.manifest.root_format).not.toBe("windows-prefetch");
});

it("calls a checksum-bearing capture ending inside the MAM header truncated", async () => {
  const reader = await readerFor(
    prefetchFixture({
      version: "23",
      compressed: true,
      checksum: true,
    }).subarray(0, 10),
  );
  try {
    await expect(inventory(reader)).rejects.toMatchObject({
      reason: "truncated",
      message: expect.stringContaining("MAM container header") as unknown,
    });
  } finally {
    await reader.close();
  }
});

it.each([
  ["inside the version byte", 4],
  ["inside the uncompressed-size field", 5],
  ["after the compression byte but inside the size field", 6],
  ["inside the last size byte", 7],
] as const)(
  "routes a MAM capture truncated %s to the Prefetch reader",
  async (_label, length) => {
    // The four-byte signature establishes MAM ownership; a capture that ends
    // inside the fixed header is a truncated container, not an executable. A
    // signature-only probe falls through to executable parsing, where this
    // truncation is indistinguishable from corruption.
    const bytes = prefetchFixture({ version: "23", compressed: true }).subarray(
      0,
      length,
    );
    await expect(
      scanCanonicalArtifactInventory(
        await writePrefetch("MAM-truncated.bin", bytes),
      ),
    ).rejects.toMatchObject({
      reason: "truncated",
      message: expect.stringContaining(
        "ends inside the MAM container header",
      ) as unknown,
    });
  },
);

it.each([
  ["17", 0x78],
  ["23", 0x80],
] as const)(
  "keeps the last-run timestamp unknown when a v%s capture ends before 0x%i",
  async (version, offset) => {
    // The file-information block is reached, but the generation's own FILETIME
    // is not, so presence cannot be claimed from the metrics array alone.
    const reader = await readerFor(
      prefetchFixture({ version }).subarray(0, offset + 4),
    );
    try {
      await inventory(reader);
      expect(reader.formatMetadata()).toMatchObject({ run_time_slots: null });
    } finally {
      await reader.close();
    }
  },
);

it("reports a truncated header as a format failure", async () => {
  const reader = await readerFor(
    prefetchFixture({ version: "23" }).subarray(0, 40),
  );
  try {
    await expect(inventory(reader)).rejects.toBeInstanceOf(
      ArtifactReaderFailure,
    );
  } finally {
    await reader.close();
  }
});

it("does not claim bytes that lack a Prefetch signature", async () => {
  const bytes = Buffer.alloc(128, 0x41);
  bytes.write("MZ", 0);
  const reader = await readerFor(bytes);
  try {
    await expect(inventory(reader)).rejects.toMatchObject({
      message: expect.stringContaining("No Prefetch generation") as unknown,
    });
  } finally {
    await reader.close();
  }
});

it("inventories a .pf file as windows-prefetch end to end", async () => {
  const path = await writePrefetch(
    "GOOGLE.EXE-1A2B3C4D.pf",
    prefetchFixture({ version: "23" }),
  );
  const snapshot = await scanCanonicalArtifactInventory(path);
  expect(snapshot.manifest.root_format).toBe("windows-prefetch");
  expect(snapshot.coverage).toMatchObject({
    scope: "container-entries",
    status: "complete",
  });
  const root = snapshot.occurrences.find((row) => row.logical_path === ".");
  expect(root).toMatchObject({
    artifact_kind: "container",
    artifact_format: "windows-prefetch",
    format_metadata: {
      kind: "windows-prefetch",
      executable_name: "GOOGLE.EXE",
      run_count: 7,
    },
  });
  expect(
    snapshot.limitations.some((limitation) =>
      limitation.startsWith("Windows Prefetch inventory"),
    ),
  ).toBe(true);
});

it("rejects Prefetch sizes the parser cannot report", async () => {
  // A successful parse always holds the 84-byte common header. A persisted
  // observation must represent its file size as an exact integer.
  const facts = {
    kind: "windows-prefetch",
    version: "23",
    file_bytes: 84,
    declared_file_bytes: 0,
    executable_name: null,
    executable_path_hash: "1a2b3c4d",
    run_count: null,
    run_time_slots: null,
  } as const;
  expect(prefetchMetadataSchema.parse(facts)).toMatchObject({ file_bytes: 84 });
  for (const invalid of [0, 83, Number.MAX_SAFE_INTEGER + 1, -1, 1.5])
    expect(() =>
      prefetchMetadataSchema.parse({ ...facts, file_bytes: invalid }),
    ).toThrow();
});

it("rejects run facts a capture this small could not report", async () => {
  // A capture reports the last-run FILETIME only from 128 bytes (v17) or 136
  // (v23), and the run count only from 148 (v17) or 156 (v23). Members are
  // reachable only once the bytes reach them, so these combinations are
  // impossible Evidence even though each member alone is in range.
  const facts = {
    kind: "windows-prefetch",
    version: "23",
    file_bytes: 84,
    declared_file_bytes: 0,
    executable_name: null,
    executable_path_hash: "1a2b3c4d",
    run_count: null,
    run_time_slots: null,
  } as const;
  expect(prefetchMetadataSchema.parse(facts)).toMatchObject(facts);
  for (const impossible of [
    { run_count: 7 },
    { run_time_slots: 1 },
    { run_count: 7, run_time_slots: 1 },
  ])
    expect(() =>
      prefetchMetadataSchema.parse({ ...facts, ...impossible }),
    ).toThrow();
  // Each fact becomes possible exactly at the byte the parser can reach it.
  for (const [version, fullFileBytes] of [
    ["17", 128],
    ["23", 136],
  ] as const) {
    expect(() =>
      prefetchMetadataSchema.parse({
        ...facts,
        version,
        file_bytes: fullFileBytes - 1,
        run_time_slots: 1,
      }),
    ).toThrow();
    expect(
      prefetchMetadataSchema.parse({
        ...facts,
        version,
        file_bytes: fullFileBytes,
        run_time_slots: 1,
      }),
    ).toMatchObject({ run_time_slots: 1 });
  }
  // The run count is generation-specific: v17 reaches it at 0x94 (148 bytes),
  // v23 at 0x9c (156). A capture one byte short of the field cannot report it.
  for (const [version, runCountBytes] of [
    ["17", 148],
    ["23", 156],
  ] as const) {
    expect(() =>
      prefetchMetadataSchema.parse({
        ...facts,
        version,
        file_bytes: runCountBytes - 1,
        run_count: 7,
      }),
    ).toThrow();
    expect(
      prefetchMetadataSchema.parse({
        ...facts,
        version,
        file_bytes: runCountBytes,
        run_count: 7,
        run_time_slots: 1,
      }),
    ).toMatchObject({ run_count: 7, run_time_slots: 1 });
  }
});

it("rejects a name hash that is not eight lowercase hex digits", async () => {
  // A persisted or client-supplied inventory parses `format_metadata` through
  // this schema, so a value the producer never emits must fail at the boundary
  // rather than propagate as a four-byte path hash.
  const facts = {
    kind: "windows-prefetch",
    version: "23",
    file_bytes: 84,
    declared_file_bytes: 0,
    executable_name: null,
    run_count: null,
    run_time_slots: null,
  } as const;
  expect(
    prefetchMetadataSchema.parse({
      ...facts,
      executable_path_hash: "1a2b3c4d",
    }),
  ).toMatchObject({ executable_path_hash: "1a2b3c4d" });
  // A successful parse always reaches the hash word, so null is impossible
  // Evidence rather than an absent fact.
  expect(() =>
    prefetchMetadataSchema.parse({ ...facts, executable_path_hash: null }),
  ).toThrow();
  for (const invalid of ["not-a-hash", "1A2B3C4D", "1a2b3c4", "1a2b3c4d5"])
    expect(() =>
      prefetchMetadataSchema.parse({ ...facts, executable_path_hash: invalid }),
    ).toThrow();
});

it("bounds the executable name to what the header field holds", async () => {
  // `utf16Name()` reads at most 30 UTF-16 code units and stops at the first
  // NUL, so an empty, NUL-bearing or over-long name is impossible Evidence.
  const facts = {
    kind: "windows-prefetch",
    version: "23",
    file_bytes: 84,
    declared_file_bytes: 0,
    executable_name: "GOOGLE.EXE",
    executable_path_hash: "1a2b3c4d",
    run_count: null,
    run_time_slots: null,
  } as const;
  expect(prefetchMetadataSchema.parse(facts)).toMatchObject({
    executable_name: "GOOGLE.EXE",
  });
  expect(
    prefetchMetadataSchema.parse({ ...facts, executable_name: null }),
  ).toMatchObject({ executable_name: null });
  expect(
    prefetchMetadataSchema.parse({ ...facts, executable_name: "A".repeat(30) }),
  ).toMatchObject({ executable_name: "A".repeat(30) });
  for (const invalid of ["", "GOOGLE\u0000.EXE", "A".repeat(31)])
    expect(() =>
      prefetchMetadataSchema.parse({ ...facts, executable_name: invalid }),
    ).toThrow();
});

it("retries a shared preparation cancelled by another traversal", async () => {
  const reader = await readerFor(prefetchFixture({ version: "23" }));
  const controller = new AbortController();
  let entered: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let releaseRead: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const read = ArtifactFileSource.prototype.read;
  const spy = vi
    .spyOn(ArtifactFileSource.prototype, "read")
    .mockImplementationOnce(async function (this: ArtifactFileSource, signal) {
      assertArtifactReadActive(signal);
      entered();
      await held;
      assertArtifactReadActive(signal);
      return read.call(this, signal);
    });
  const cancelled = reader
    .entries(controller.signal)
    [Symbol.asyncIterator]()
    .next();
  let other: typeof cancelled | undefined;
  try {
    await awaitAcknowledgement(
      started,
      cancelled,
      "Prefetch preparation source read",
    );
    other = reader.entries()[Symbol.asyncIterator]().next();
    controller.abort("cancelled first traversal");
    releaseRead();
    await Promise.all([
      expect(cancelled).rejects.toMatchObject({ reason: "cancelled" }),
      expect(other).resolves.toMatchObject({ done: true }),
    ]);
    expect(reader.formatMetadata()).toMatchObject({
      executable_name: "GOOGLE.EXE",
    });
  } finally {
    controller.abort();
    releaseRead();
    await Promise.allSettled([cancelled, other]);
    spy.mockRestore();
    await reader.close();
  }
});

it.each(["valid", "truncated"] as const)(
  "verifies the source after reading a %s header before publishing its outcome",
  async (header) => {
    const fixture = prefetchFixture({ version: "23" });
    const bytes = header === "valid" ? fixture : fixture.subarray(0, 60);
    const headerLength = Math.min(bytes.length, PREFETCH_HEADER_READ_BYTES);
    const path = await writePrefetch("program.pf", bytes);
    const admitted = await openRegularFile(path, { symlinks: "reject" });
    const { handle } = admitted;
    const reader = new WindowsPrefetchArtifactReader(path, admitted);
    const nativeRead = handle.read.bind(handle);
    const nativeStat = handle.stat.bind(handle);
    const failure = new Error("final source verification failed");
    let captured = 0;
    let verifiedAfterRead = false;
    const reads = vi.spyOn(handle, "read").mockImplementation((async (
      ...args: unknown[]
    ) => {
      const result = (await Reflect.apply(nativeRead, handle, args)) as {
        bytesRead: number;
      };
      captured += result.bytesRead;
      if (header === "truncated" && captured === headerLength)
        await appendFile(path, "changed");
      return result;
    }) as typeof handle.read);
    const stats = vi.spyOn(handle, "stat").mockImplementation((async (
      ...args: unknown[]
    ) => {
      if (captured === headerLength) {
        verifiedAfterRead = true;
        if (header === "valid") throw failure;
      }
      return Reflect.apply(nativeStat, handle, args);
    }) as typeof handle.stat);
    try {
      if (header === "valid")
        await expect(inventory(reader)).rejects.toBe(failure);
      else
        await expect(inventory(reader)).rejects.toMatchObject({
          reason: "integrity",
          integrityCheck: "container-identity",
        });
      expect(verifiedAfterRead).toBe(true);
      expect(reader.formatMetadata()).toBeUndefined();
      if (header === "valid") {
        reads.mockRestore();
        stats.mockRestore();
        await inventory(reader);
        expect(reader.formatMetadata()).toMatchObject({
          kind: "windows-prefetch",
          executable_name: "GOOGLE.EXE",
        });
      }
    } finally {
      try {
        await reader.close();
      } finally {
        reads.mockRestore();
        stats.mockRestore();
        await handle.close();
      }
    }
  },
);
