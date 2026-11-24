import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scheduler } from "node:timers/promises";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect, it, onTestFinished, vi } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";
import {
  readAndroidJniLibraries,
  ANDROID_JNI_LIBRARY_LIMITS,
} from "../../../src/android/AndroidJniLibraries.js";
import { JadxInterruption } from "../../../src/android/JadxInterruption.js";
import { ArtifactResourceScope } from "../../../src/resources/ArtifactResourceScope.js";
import {
  AnalysisCancelledError,
  AnalysisTimeoutError,
} from "../../../src/domain/analysisErrorCore.js";
import { AnalysisError } from "../../../src/domain/analysisErrorBase.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import {
  type AndroidJniSelection,
  androidJniLibraryCheckpointSchema,
  type AndroidJniLibraryCheckpoint,
} from "../../../src/domain/android/androidJniBindings.js";
import { androidPartialObservationSchema } from "../../../src/domain/android/androidPartialObservation.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { ZIP_ZSTANDARD_WINDOW_CEILING } from "../../../src/resources/ZipArtifactReader.js";
import {
  zstandardWindowFrameFixture,
  zstandardZipFixture,
} from "../../fixtures/zipZstandard.js";
import { jniElfFixture } from "../../fixtures/android/jniElf.js";
import { runWithAnalysisOperationSnapshot } from "../../../src/domain/analysisOperationSnapshot.js";
import { elfFrameAllowanceFixture } from "../../fixtures/binaryDiagnostics/elfFrameAllowance.js";
import {
  ArtifactReaderFailure,
  ZipArtifactReader,
} from "../../../src/resources/index.js";
import { InternalInvariantError } from "../../../src/domain/internalInvariant.js";
import type { ArtifactReaderFailureReason } from "../../../src/resources/ArtifactReader.js";

const OPERATION = "inspect_android_jni_bindings";
const LIBRARY = "lib/arm64-v8a/libfixture.so";
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const fixture = async (
  members: readonly (readonly [string, Uint8Array])[] = [
    [LIBRARY, jniElfFixture().bytes],
  ],
  rename?: readonly [string, string],
) => {
  const directory = await createTestTempDirectory("rea-android-jni-libraries-");
  const snapshot = join(directory, "selected app.apk");
  const resources = new ArtifactResourceScope();
  onTestFinished(async () => {
    await resources.close();
  });
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    useWebWorkers: false,
  });
  for (const [path, bytes] of members)
    await writer.add(path, new Uint8ArrayReader(bytes), {
      level: 0,
      lastModDate: new Date("2020-01-01T00:00:00Z"),
    });
  const bytes = Buffer.from(await writer.close());
  if (rename !== undefined) {
    const before = Buffer.from(rename[0]),
      after = Buffer.from(rename[1]);
    expect(before.length).toBe(after.length);
    let changed = 0;
    for (
      let at = bytes.indexOf(before);
      at >= 0;
      at = bytes.indexOf(before, at + after.length)
    ) {
      after.copy(bytes, at);
      changed++;
    }
    // Only the independently authored local and central member-name fields.
    expect(changed).toBe(2);
  }
  await writeFile(snapshot, bytes);
  return { snapshot, apkSha256: digest(bytes), resources };
};
type Fixture = Awaited<ReturnType<typeof fixture>>;
const read = (
  source: Fixture,
  selection: AndroidJniSelection = {},
  signal = new AbortController().signal,
  interruption = (reason: unknown): AnalysisError =>
    new AnalysisCancelledError(OPERATION, { cause: reason }),
  onObservation: (checkpoint: AndroidJniLibraryCheckpoint) => void = () => {},
) =>
  readAndroidJniLibraries({
    ...source,
    selection,
    signal,
    interruption,
    onObservation,
  });

const partial = (source: Fixture, checkpoint: AndroidJniLibraryCheckpoint) => ({
  provider_id: "jadx",
  operation: OPERATION,
  target: {
    selected_path: source.snapshot,
    path: source.snapshot,
    sha256: source.apkSha256,
    format: "apk",
  },
  provider_facts: {
    jar_sha256: null,
    bridge_sha256: null,
    bridge_name: "fixture-checkpoint",
    bridge_version: "1",
    server_name: null,
    server_version: null,
    engine_version: null,
  },
  calls: [],
  jni: { selection: {}, native_inventory: null, libraries: checkpoint },
});

it("keeps duplicate library-name occurrences bound to their own opaque ZIP keys", async () => {
  const bytes = jniElfFixture().bytes;
  const first = "lib/arm64-v8a/libcopy1.so",
    second = "lib/arm64-v8a/libcopy2.so";
  const source = await fixture(
    [
      ["assets/ignored.so", Buffer.from("an unrelated member")],
      [first, bytes],
      [second, bytes],
    ],
    [second, first],
  );
  const result = await read(source);
  expect(result.inventory).toMatchObject({
    status: "complete",
    examined_entries: 3,
    selected_libraries: 2,
  });
  expect(result.libraries.map((library) => library.path)).toEqual([
    first,
    first,
  ]);
  expect(result.libraries.map((library) => library.source_path)).toEqual([
    first,
    first,
  ]);
  expect(result.libraries.map((library) => library.source_index)).toEqual([
    1, 2,
  ]);
  expect(
    result.libraries.every(
      (library) => library.sha256 === digest(bytes) && library.facts !== null,
    ),
  ).toBe(true);
  expect(
    new Set(result.libraries.map((library) => library.source_key)).size,
  ).toBe(2);
  expect(
    new Set(result.libraries.map((library) => library.library_id)).size,
  ).toBe(2);
  const repeated = await read(source);
  expect(
    repeated.libraries.map(({ library_id, source_key }) => ({
      library_id,
      source_key,
    })),
  ).toEqual(
    result.libraries.map(({ library_id, source_key }) => ({
      library_id,
      source_key,
    })),
  );
  expect(source.resources.hasPending).toBe(false);
});

it.each([{ abis: [] }, { library_paths: [] }])(
  "applies explicit empty selection %j before opening library bytes",
  async (selection) => {
    const source = await fixture([
      [LIBRARY, Buffer.from("deliberately malformed ELF")],
    ]);
    const open = vi.spyOn(ZipArtifactReader.prototype, "open");
    try {
      const result = await read(source, selection);
      expect(result.libraries).toEqual([]);
      expect(result.inventory).toMatchObject({
        status: "complete",
        examined_entries: 1,
        selected_libraries: 0,
      });
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  },
);

it("retains a malformed selected library's exact carrier identity and digest", async () => {
  const path = "lib/arm64-v8a/lib selected_原#.so";
  const bytes = Buffer.from("not an ELF image\0caller evidence");
  const source = await fixture([[path, bytes]]);
  const result = await read(source);
  expect(result.libraries).toHaveLength(1);
  expect(result.libraries[0]).toMatchObject({
    path,
    source_path: path,
    abi: "arm64-v8a",
    sha256: digest(bytes),
    size: bytes.length,
    declared_size: bytes.length,
    compressed_size: bytes.length,
    facts: null,
  });
  expect(result.libraries[0]?.failure).toMatchObject({
    kind: expect.stringMatching(/^(?:malformed|unsupported)$/u),
    message: expect.any(String),
  });
  expect(source.resources.hasPending).toBe(false);
});

it("keeps the ZIP decoder window's recompression advice in the library failure", async () => {
  const directory = await createTestTempDirectory("rea-android-jni-zstd-");
  const snapshot = join(directory, "window.apk");
  // Window descriptor 0x90 declares 256 MiB, above the ZIP reader's window.
  const { content, compressed } = zstandardWindowFrameFixture(0x90);
  const bytes = zstandardZipFixture(content, { compressed, name: LIBRARY });
  await writeFile(snapshot, bytes);
  const resources = new ArtifactResourceScope();
  onTestFinished(async () => {
    await resources.close();
  });
  const result = await read({ snapshot, apkSha256: digest(bytes), resources });
  expect(result.libraries[0]?.failure).toMatchObject({
    kind: "limit",
    message: expect.stringContaining(ZIP_ZSTANDARD_WINDOW_CEILING.narrowing!),
  });
});

it("retains a backed library identity when the ELF section-name frame budget is refused", async () => {
  const bytes = elfFrameAllowanceFixture();
  const library = "lib/x86_64/libframe.so";
  const source = await fixture([
    [library, bytes],
    [LIBRARY, jniElfFixture().bytes],
  ]);
  const result = await runWithAnalysisOperationSnapshot(
    { revision: 1, overrides: { "zstd.max_frames": 1 } },
    () => read(source),
  );
  expect(result.libraries).toEqual([
    expect.objectContaining({
      path: library,
      size: bytes.length,
      sha256: digest(bytes),
      facts: null,
      failure: {
        kind: "capacity",
        message: expect.stringContaining("zstd.max_frames"),
      },
    }),
    expect.objectContaining({
      path: LIBRARY,
      facts: expect.any(Object),
      failure: null,
    }),
  ]);
  expect(source.resources.hasPending).toBe(false);

  const checkpoints: AndroidJniLibraryCheckpoint[] = [];
  const close = vi
    .spyOn(ZipArtifactReader.prototype, "close")
    .mockRejectedValueOnce(new Error("controlled ZIP close failure"));
  try {
    await expect(
      runWithAnalysisOperationSnapshot(
        { revision: 1, overrides: { "zstd.max_frames": 1 } },
        () =>
          read(source, {}, undefined, undefined, (checkpoint) =>
            checkpoints.push(checkpoint),
          ),
      ),
    ).rejects.toBeInstanceOf(ProviderCleanupError);
    expect(checkpoints[0]?.libraries).toEqual(result.libraries);
    expect(source.resources.hasPending).toBe(true);
  } finally {
    close.mockRestore();
    await source.resources.close();
  }
});

it("preserves declared capacity metadata without presenting unread bytes as verified", async () => {
  const source = await fixture();
  const originalEntries = ZipArtifactReader.prototype.entries;
  const declared = ANDROID_JNI_LIBRARY_LIMITS.libraryBytes + 1;
  const entries = vi
    .spyOn(ZipArtifactReader.prototype, "entries")
    .mockImplementation(async function* (this: ZipArtifactReader, signal) {
      for await (const entry of originalEntries.call(this, signal))
        yield { ...entry, declaredSize: declared, compressedSize: 1234 };
    });
  const open = vi.spyOn(ZipArtifactReader.prototype, "open");
  try {
    const result = await read(source);
    expect(result.libraries[0]).toMatchObject({
      path: LIBRARY,
      declared_size: declared,
      compressed_size: 1234,
      sha256: null,
      size: null,
      facts: null,
      failure: { kind: "capacity" },
    });
    expect(open).not.toHaveBeenCalled();
  } finally {
    entries.mockRestore();
    open.mockRestore();
  }
});

it("names the reader check when a selected library fails an integrity check", async () => {
  const source = await fixture();
  const originalEntries = ZipArtifactReader.prototype.entries;
  const entries = vi
    .spyOn(ZipArtifactReader.prototype, "entries")
    .mockImplementation(async function* (this: ZipArtifactReader, signal) {
      for await (const entry of originalEntries.call(this, signal))
        yield { ...entry, declaredSize: (entry.declaredSize ?? 0) + 1 };
    });
  try {
    const result = await read(source);
    const failure = result.libraries[0]?.failure;
    // The reader refuses an entry whose metadata differs from what it produced.
    expect(failure).toMatchObject({
      kind: "integrity",
      integrity_check: "entry-metadata",
    });
    // The checkpoint schema retains the check across Evidence boundaries.
    expect(
      androidJniLibraryCheckpointSchema.parse({
        scan_state: "completed",
        libraries: result.libraries,
        inventory: result.inventory,
      }).libraries[0]?.failure,
    ).toEqual(failure);
    // An integrity failure without its check, or a check on another kind, is
    // refused by the runtime schema and by its JSON Schema conversion.
    const library = result.libraries[0];
    const checkpoint = (failure: unknown) => ({
      scan_state: "completed",
      libraries: [{ ...library, failure }],
      inventory: result.inventory,
    });
    const advertised = new Ajv2020({ strict: false }).compile(
      z.toJSONSchema(androidJniLibraryCheckpointSchema, { io: "output" }),
    );
    expect(advertised(checkpoint(failure))).toBe(true);
    for (const malformed of [
      { kind: "integrity", message: "x" },
      { kind: "io", message: "x", integrity_check: "entry-metadata" },
    ]) {
      expect(
        androidJniLibraryCheckpointSchema.safeParse(checkpoint(malformed))
          .success,
      ).toBe(false);
      expect(advertised(checkpoint(malformed))).toBe(false);
    }
  } finally {
    entries.mockRestore();
  }
});

it("refuses an integrity read failure that names no check and releases the reader", async () => {
  const source = await fixture();
  // Only the non-literal rebuild constructor can carry an explicit undefined check.
  const reason: ArtifactReaderFailureReason = "integrity";
  const open = vi.spyOn(ZipArtifactReader.prototype, "open").mockRejectedValue(
    new ArtifactReaderFailure(reason, "unnamed check", {
      integrityCheck: undefined,
    }),
  );
  const close = vi.spyOn(ZipArtifactReader.prototype, "close");
  const observations: AndroidJniLibraryCheckpoint[] = [];
  try {
    const failure = await read(source, {}, undefined, undefined, (checkpoint) =>
      observations.push(checkpoint),
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(Error);
    expect(
      failure instanceof Error &&
        [failure, failure.cause].some(
          (error) => error instanceof InternalInvariantError,
        ),
    ).toBe(true);
    expect(close).toHaveBeenCalled();
    for (const checkpoint of observations)
      expect(
        androidJniLibraryCheckpointSchema.safeParse(checkpoint).success,
      ).toBe(true);
  } finally {
    open.mockRestore();
    close.mockRestore();
  }
});

it("retains the live reader after failed close and gates the next read on its cleanup retry", async () => {
  const source = await fixture();
  const originalClose = ZipArtifactReader.prototype.close;
  const attempts: ZipArtifactReader[] = [];
  let allowClose = false;
  const closeCause = new Error("controlled live ZIP reader close failure");
  const close = vi
    .spyOn(ZipArtifactReader.prototype, "close")
    .mockImplementation(async function (this: ZipArtifactReader) {
      attempts.push(this);
      if (!allowClose) throw closeCause;
      await originalClose.call(this);
    });
  const open = vi.spyOn(ZipArtifactReader.prototype, "open");
  const observations: AndroidJniLibraryCheckpoint[] = [];
  try {
    const first = await read(source, {}, undefined, undefined, (checkpoint) =>
      observations.push(checkpoint),
    ).catch((cause: unknown) => cause);
    expect(first).toBeInstanceOf(ProviderCleanupError);
    if (!(first instanceof ProviderCleanupError)) throw first;
    expect(first.cleanupIncomplete).toBe(true);
    expect(first.cleanupResources).toContain(source.snapshot);
    expect(source.resources.hasPending).toBe(true);
    const checkpoint = observations[0];
    expect(checkpoint).toMatchObject({
      scan_state: "completed",
      inventory: { status: "complete", selected_libraries: 1 },
    });
    expect(
      androidJniLibraryCheckpointSchema.safeParse(checkpoint).success,
    ).toBe(true);
    expect(checkpoint?.libraries[0]).toMatchObject({
      path: LIBRARY,
      sha256: digest(jniElfFixture().bytes),
      size: jniElfFixture().bytes.length,
      facts: { tables: expect.any(Array) },
    });
    expect(
      checkpoint?.libraries[0]?.facts?.tables.flatMap((table) => table.entries),
    ).toHaveLength(3);
    if (checkpoint === undefined)
      throw new Error("Missing parsed library checkpoint");
    expect(
      androidPartialObservationSchema.safeParse(partial(source, checkpoint))
        .success,
    ).toBe(true);
    expect(
      androidPartialObservationSchema.safeParse({
        ...partial(source, checkpoint),
        operation: "inspect_android_package",
      }).success,
    ).toBe(false);
    const historical = structuredClone(checkpoint);
    const owner = attempts[0];
    if (owner === undefined) throw new Error("No retained ZIP reader owner");
    // Close interception preceded the actual close: verify the real resource is
    // still readable, rather than claiming a closed descriptor remains owned.
    const retainedPaths: string[] = [];
    for await (const entry of owner.entries()) retainedPaths.push(entry.path);
    expect(retainedPaths).toEqual([LIBRARY]);
    const blocked = await read(source).catch((cause: unknown) => cause);
    expect(blocked).toBeInstanceOf(AnalysisError);
    if (!(blocked instanceof AnalysisError)) throw blocked;
    expect(blocked.cleanupIncomplete).toBe(true);
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts.every((attempt) => attempt === owner)).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(source.resources.hasPending).toBe(true);
    allowClose = true;
    const recovered = await read(source);
    expect(recovered.libraries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: LIBRARY,
          facts: expect.objectContaining({ tables: expect.any(Array) }),
        }),
      ]),
    );
    expect(open).toHaveBeenCalledTimes(2);
    expect(source.resources.hasPending).toBe(false);
    expect(first.cleanupIncomplete).toBe(false);
    expect(blocked.cleanupIncomplete).toBe(false);
    expect(checkpoint).toEqual(historical);
    expect(attempts.at(-1)).not.toBe(owner);
    const closed = async () => {
      for await (const entry of owner.entries())
        throw new Error(`Closed reader unexpectedly yielded ${entry.path}`);
    };
    await expect(closed()).rejects.toMatchObject({ reason: "unavailable" });
  } finally {
    allowClose = true;
    try {
      await source.resources.close();
    } finally {
      close.mockRestore();
      open.mockRestore();
    }
  }
});

for (const first of ["caller", "deadline"] as const)
  for (const cleanupFails of [false, true])
    it(`preserves ${first}-first interruption during final ZIP close (cleanup fails: ${cleanupFails})`, async () => {
      const source = await fixture();
      const caller = new AbortController(),
        deadline = new AbortController();
      const callerReason = { caller: "exact selected caller cause" };
      const deadlineReason = { deadline: "exact selected deadline cause" };
      const signal = AbortSignal.any([caller.signal, deadline.signal]);
      const reason = first === "caller" ? callerReason : deadlineReason;
      const primary =
        first === "caller"
          ? new AnalysisCancelledError(OPERATION, { cause: reason })
          : new AnalysisTimeoutError(OPERATION, 25, { cause: reason });
      const interruption = vi.fn((observed: unknown) => {
        expect(observed).toBe(reason);
        return primary;
      });
      const originalClose = ZipArtifactReader.prototype.close;
      let checkpoint: AndroidJniLibraryCheckpoint | undefined;
      let injected = false,
        allowClose = !cleanupFails;
      const close = vi
        .spyOn(ZipArtifactReader.prototype, "close")
        .mockImplementation(async function (this: ZipArtifactReader) {
          if (!injected) {
            injected = true;
            if (first === "caller") {
              caller.abort(callerReason);
              deadline.abort(deadlineReason);
            } else {
              deadline.abort(deadlineReason);
              caller.abort(callerReason);
            }
          }
          if (!allowClose)
            throw new Error("controlled finalization close failure");
          await originalClose.call(this);
        });
      try {
        const failure = await read(
          source,
          {},
          signal,
          interruption,
          (observation) => {
            checkpoint = observation;
          },
        ).catch((cause: unknown) => cause);
        const expectedCode =
          first === "caller" ? "cancelled" : "provider_timeout";
        expect(checkpoint).toMatchObject({
          scan_state: "completed",
          inventory: { status: "complete", selected_libraries: 1 },
        });
        expect(checkpoint?.libraries[0]?.sha256).toBe(
          digest(jniElfFixture().bytes),
        );
        expect(
          checkpoint?.libraries[0]?.facts?.tables.flatMap(
            (table) => table.entries,
          ),
        ).toHaveLength(3);
        if (checkpoint === undefined)
          throw new Error("Missing final-close checkpoint");
        expect(
          androidPartialObservationSchema.safeParse(partial(source, checkpoint))
            .success,
        ).toBe(true);
        const historical = structuredClone(checkpoint);
        if (cleanupFails) {
          expect(interruption).toHaveBeenCalledTimes(1);
          expect(failure).toBeInstanceOf(AnalysisError);
          if (!(failure instanceof AnalysisError)) throw failure;
          expect(failure.cleanupPrimary).toBe(primary);
          expect(primary.cause).toBe(reason);
          expect(projectAnalysisError(failure)).toMatchObject({
            code: "cleanup_incomplete",
            details: { execution_failure: expectedCode },
          });
          expect(source.resources.hasPending).toBe(true);
          allowClose = true;
          await source.resources.retryCleanup();
          expect(source.resources.hasPending).toBe(false);
          expect(failure.cleanupIncomplete).toBe(false);
          expect(projectAnalysisError(failure).code).toBe(expectedCode);
          expect(failure.cleanupPrimary?.cause).toBe(reason);
        } else {
          expect(failure).toBeInstanceOf(JadxInterruption);
          if (!(failure instanceof JadxInterruption)) throw failure;
          expect(failure.reason).toBe(reason);
          expect(interruption).not.toHaveBeenCalled();
          expect(source.resources.hasPending).toBe(false);
        }
        expect(checkpoint).toEqual(historical);
      } finally {
        allowClose = true;
        try {
          await source.resources.close();
        } finally {
          close.mockRestore();
        }
      }
    });

it.each(["member open", "section names"] as const)(
  "keeps completed facts and the interrupted carrier when a later library is cancelled during %s",
  async (stage) => {
    const parsingNames = stage === "section names";
    const second = "lib/arm64-v8a/libsecond.so",
      third = "lib/arm64-v8a/libunexamined.so";
    const bytes = jniElfFixture().bytes;
    const secondBytes = parsingNames ? elfFrameAllowanceFixture() : bytes;
    const source = await fixture([
      [LIBRARY, bytes],
      [second, secondBytes],
      [third, bytes],
    ]);
    const controller = new AbortController(),
      reason = { caller: "stop during " + stage };
    const originalOpen = ZipArtifactReader.prototype.open;
    const open = vi
      .spyOn(ZipArtifactReader.prototype, "open")
      .mockImplementation(async function (
        this: ZipArtifactReader,
        entry,
        signal,
      ) {
        if (entry.path === second && !parsingNames) {
          controller.abort(reason);
          throw new JadxInterruption(reason);
        }
        return originalOpen.call(this, entry, signal);
      });
    const yieldToEventLoop = scheduler.yield.bind(scheduler);
    const pause = parsingNames
      ? vi.spyOn(scheduler, "yield").mockImplementationOnce(async () => {
          await yieldToEventLoop();
          controller.abort(reason);
        })
      : undefined;
    let checkpoint: AndroidJniLibraryCheckpoint | undefined;
    try {
      const failure = await read(
        source,
        {},
        controller.signal,
        undefined,
        (value) => {
          checkpoint = value;
        },
      ).catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(AnalysisCancelledError);
      if (!(failure instanceof AnalysisCancelledError)) throw failure;
      expect(failure.cause).toBe(reason);
      expect(checkpoint).toMatchObject({
        scan_state: "interrupted",
        inventory: {
          status: "partial",
          examined_entries: 2,
          selected_libraries: 2,
        },
      });
      expect(checkpoint?.libraries.map((library) => library.path)).toEqual([
        LIBRARY,
        second,
      ]);
      expect(checkpoint?.libraries[0]).toMatchObject({
        sha256: digest(bytes),
        size: bytes.length,
        facts: { tables: expect.any(Array) },
      });
      expect(checkpoint?.libraries[1]).toMatchObject({
        sha256: parsingNames ? digest(secondBytes) : null,
        size: parsingNames ? secondBytes.length : null,
        declared_size: secondBytes.length,
        compressed_size: secondBytes.length,
        facts: null,
        failure: { kind: "incomplete" },
      });
      expect(checkpoint?.inventory.unknowns.join("\n")).toContain(
        "unexamined selected occurrences remain unknown",
      );
      if (checkpoint === undefined)
        throw new Error("Missing interrupted scan checkpoint");
      expect(
        androidPartialObservationSchema.safeParse(partial(source, checkpoint))
          .success,
      ).toBe(true);
      expect(JSON.parse(JSON.stringify(checkpoint))).toEqual(checkpoint);
      expect(source.resources.hasPending).toBe(false);
      if (parsingNames) {
        const retry = await read(source);
        expect(retry.inventory).toMatchObject({
          status: "complete",
          selected_libraries: 3,
        });
        expect(retry.libraries[1]).toMatchObject({
          path: second,
          sha256: digest(secondBytes),
          size: secondBytes.length,
          facts: expect.any(Object),
          failure: null,
        });
      }
    } finally {
      pause?.mockRestore();
      open.mockRestore();
    }
  },
);
