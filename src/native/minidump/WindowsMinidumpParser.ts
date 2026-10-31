import { setImmediate } from "node:timers/promises";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import {
  WINDOWS_MINIDUMP_AMD64_CONTEXT,
  WINDOWS_MINIDUMP_AMD64_CONTEXT_MIN_BYTES,
  WINDOWS_MINIDUMP_ARCHITECTURES,
  WINDOWS_MINIDUMP_INTERPRETED_STREAMS,
  type InspectWindowsMinidumpInput,
  type WindowsMinidump,
  type WindowsMinidumpRange,
} from "../../domain/native/windowsMinidump.js";

const SIGNATURE = 0x504d444d; // "MDMP"
const VERSION = 0xa793;
const HEADER_BYTES = 32;
const DIRECTORY_ENTRY_BYTES = 12;
const THREAD_BYTES = 48;
const MODULE_BYTES = 108;
const MEMORY_BYTES = 16;
const EXCEPTION_BYTES = 168;
const SYSTEM_INFO_BYTES = 56;
const MAX_NAME_BYTES = 65536;
const YIELD_EVERY = 1024;
// Cumulative recorded-name bytes; each byte expands into a decoded string and
// two hex characters, so repeated descriptors must not multiply allocations.
export const MAX_TOTAL_NAME_BYTES = 16 * 1024 * 1024;
const EXCEPTION_PARAMETER_SLOTS = 15;

const failure = (message: string): never => {
  throw new ArtifactReaderFailure("format", message);
};
const hex = (value: bigint): string => `0x${value.toString(16)}`;

/** Decode a bounded stream subset; never resolves symbols, files or live processes. */
export const parseWindowsMinidump = async (
  bytes: Buffer,
  artifact: WindowsMinidump["artifact"],
  input: InspectWindowsMinidumpInput,
  signal?: AbortSignal,
): Promise<WindowsMinidump> => {
  signal?.throwIfAborted();
  let examined = 0;
  const examine = async (entries: number): Promise<void> => {
    if (examined + entries > input.max_entries)
      throw new ArtifactReaderFailure(
        "limit",
        `Minidump descriptors exceed the ${String(input.max_entries)} entry budget.`,
        { boundary: "capacity" },
      );
    const before = examined;
    examined += entries;
    if (
      Math.floor(before / YIELD_EVERY) !== Math.floor(examined / YIELD_EVERY)
    ) {
      await setImmediate();
      signal?.throwIfAborted();
    }
  };
  // Yield inside every descriptor loop so cancellation and peer requests run.
  const tick = async (index: number): Promise<void> => {
    if (index % YIELD_EVERY === YIELD_EVERY - 1) {
      await setImmediate();
      signal?.throwIfAborted();
    }
  };
  const require = (
    offset: number,
    length: number,
    what: string,
  ): WindowsMinidumpRange => {
    if (offset < 0 || length < 0 || offset > bytes.length - length)
      failure(
        `${what} range 0x${offset.toString(16)}+0x${length.toString(16)} is truncated by the ${String(bytes.length)}-byte file.`,
      );
    return { offset, bytes: length };
  };
  const location = (at: number, what: string): WindowsMinidumpRange => {
    require(at, 8, `${what} location descriptor`);
    return require(bytes.readUInt32LE(at + 4), bytes.readUInt32LE(at), what);
  };

  require(0, HEADER_BYTES, "Minidump header");
  if (bytes.readUInt32LE(0) !== SIGNATURE)
    failure("Missing MDMP minidump signature.");
  const versionWord = bytes.readUInt32LE(4);
  if ((versionWord & 0xffff) !== VERSION)
    failure("Unsupported minidump header version.");
  const streamCount = bytes.readUInt32LE(8);
  const directoryRva = bytes.readUInt32LE(12);
  await examine(streamCount);
  const directory = require(directoryRva, streamCount *
    DIRECTORY_ENTRY_BYTES, "Stream directory");
  const occupied: { range: WindowsMinidumpRange; what: string }[] = [
    { range: { offset: 0, bytes: HEADER_BYTES }, what: "header" },
    { range: directory, what: "stream directory" },
  ];

  const streams: WindowsMinidump["streams"] = [];
  const byType = new Map<number, WindowsMinidumpRange>();
  for (let index = 0; index < streamCount; index++) {
    await tick(index);
    const at = directoryRva + index * DIRECTORY_ENTRY_BYTES;
    const type = bytes.readUInt32LE(at);
    const stream = location(at + 4, `Stream ${String(index)}`);
    const typeName =
      (WINDOWS_MINIDUMP_INTERPRETED_STREAMS as Record<number, string>)[type] ??
      null;
    if (typeName !== null) {
      if (byType.has(type))
        failure(
          `Duplicate ${typeName} makes the recorded inventory ambiguous.`,
        );
      byType.set(type, stream);
    }
    if (type !== 0 && stream.bytes > 0)
      occupied.push({ range: stream, what: `stream ${String(index)}` });
    streams.push({
      index,
      type,
      type_name: typeName,
      entry_location: { offset: at, bytes: DIRECTORY_ENTRY_BYTES },
      location: stream,
      interpretation:
        type === 0 ? "unused" : typeName === null ? "unknown" : "interpreted",
    });
  }
  rejectOverlaps(occupied);

  const system = byType.has(7) ? readSystem(bytes, byType.get(7)!) : null;
  const amd64 = system?.processor_architecture === 9;
  const readContext = (
    at: number,
    what: string,
  ): WindowsMinidump["threads"][number]["context"] => {
    const ctx = location(at, what);
    return {
      location: ctx,
      registers:
        amd64 && ctx.bytes >= WINDOWS_MINIDUMP_AMD64_CONTEXT_MIN_BYTES
          ? WINDOWS_MINIDUMP_AMD64_CONTEXT.map(([name, offset, width]) => ({
              name,
              value: hex(
                width === 8
                  ? bytes.readBigUInt64LE(ctx.offset + offset)
                  : BigInt(bytes.readUIntLE(ctx.offset + offset, width)),
              ),
              location: { offset: ctx.offset + offset, bytes: width },
            }))
          : null,
    };
  };

  const memoryContents: { range: WindowsMinidumpRange; what: string }[] = [];
  const listEntries = async (
    type: number,
    entryBytes: number,
  ): Promise<number[]> => {
    const stream = byType.get(type);
    if (stream === undefined) return [];
    const name =
      WINDOWS_MINIDUMP_INTERPRETED_STREAMS[
        type as keyof typeof WINDOWS_MINIDUMP_INTERPRETED_STREAMS
      ];
    if (stream.bytes < 4) failure(`${name} is shorter than its count.`);
    const entries = bytes.readUInt32LE(stream.offset);
    await examine(entries);
    const body = entries * entryBytes;
    // Some writers align entries to 8 bytes after the 32-bit count.
    const padding =
      stream.bytes === 4 + body ? 4 : stream.bytes === 8 + body ? 8 : null;
    if (padding === null)
      failure(
        `${name} declares ${String(entries)} entries but its ${String(stream.bytes)}-byte range is incomplete or carries unaccounted bytes.`,
      );
    return Array.from(
      { length: entries },
      (_unused, index) => stream.offset + padding! + index * entryBytes,
    );
  };

  const threads: WindowsMinidump["threads"] = [];
  for (const [index, at] of (await listEntries(3, THREAD_BYTES)).entries()) {
    const stack = location(at + 32, `Thread ${String(index)} stack memory`);
    // Stacks share the memory overlap check; identical aliases stay allowed.
    memoryContents.push({
      range: stack,
      what: `thread ${String(index)} stack`,
    });
    threads.push({
      index,
      entry_location: { offset: at, bytes: THREAD_BYTES },
      historical_thread_id: bytes.readUInt32LE(at),
      suspend_count: bytes.readUInt32LE(at + 4),
      priority_class: bytes.readUInt32LE(at + 8),
      priority: bytes.readUInt32LE(at + 12),
      teb: hex(bytes.readBigUInt64LE(at + 16)),
      stack: {
        start_address: hex(bytes.readBigUInt64LE(at + 24)),
        location: stack,
      },
      context: readContext(at + 40, `Thread ${String(index)} context`),
    });
    await tick(index);
  }

  const modules: WindowsMinidump["modules"] = [];
  let nameBytesTotal = 0;
  for (const [index, at] of (await listEntries(4, MODULE_BYTES)).entries()) {
    await tick(index);
    const nameRva = bytes.readUInt32LE(at + 20);
    require(nameRva, 4, `Module ${String(index)} name length`);
    const nameBytes = bytes.readUInt32LE(nameRva);
    if (nameBytes % 2 !== 0 || nameBytes > MAX_NAME_BYTES)
      failure(`Module ${String(index)} name has an invalid UTF-16 length.`);
    nameBytesTotal += nameBytes;
    if (nameBytesTotal > MAX_TOTAL_NAME_BYTES)
      throw new ArtifactReaderFailure(
        "limit",
        `Recorded module names exceed the ${String(MAX_TOTAL_NAME_BYTES)}-byte decoding budget.`,
        { boundary: "memory" },
      );
    const name = require(nameRva +
      4, nameBytes, `Module ${String(index)} name`);
    const raw = bytes.subarray(name.offset, name.offset + name.bytes);
    modules.push({
      index,
      entry_location: { offset: at, bytes: MODULE_BYTES },
      base_address: hex(bytes.readBigUInt64LE(at)),
      image_bytes: bytes.readUInt32LE(at + 8),
      checksum: bytes.readUInt32LE(at + 12),
      timestamp: bytes.readUInt32LE(at + 16),
      recorded_name: raw.toString("utf16le"),
      recorded_name_utf16le_hex: raw.toString("hex"),
      name_location: name,
      cv_record_location: location(
        at + 76,
        `Module ${String(index)} CV record`,
      ),
      misc_record_location: location(
        at + 84,
        `Module ${String(index)} misc record`,
      ),
    });
  }

  const memory: WindowsMinidump["memory"] = [];
  for (const [index, at] of (await listEntries(5, MEMORY_BYTES)).entries()) {
    await tick(index);
    const content = location(at + 8, "Memory list range");
    memoryContents.push({ range: content, what: "memory-list content" });
    memory.push({
      source: "memory-list",
      descriptor_location: { offset: at, bytes: MEMORY_BYTES },
      start_address: hex(bytes.readBigUInt64LE(at)),
      bytes: hex(BigInt(content.bytes)),
      location: content,
    });
  }
  const memory64 = byType.get(9);
  if (memory64 !== undefined) {
    if (memory64.bytes < 16)
      failure("Memory64ListStream is shorter than its header.");
    const entries = bytes.readBigUInt64LE(memory64.offset);
    if (entries > BigInt(input.max_entries))
      throw new ArtifactReaderFailure(
        "limit",
        `Minidump descriptors exceed the ${String(input.max_entries)} entry budget.`,
        { boundary: "capacity" },
      );
    await examine(Number(entries));
    if (BigInt(memory64.bytes) !== 16n + entries * 16n)
      failure("Memory64ListStream descriptor count does not match its range.");
    let rva = bytes.readBigUInt64LE(memory64.offset + 8);
    for (let index = 0; index < Number(entries); index++) {
      await tick(index);
      const at = memory64.offset + 16 + index * MEMORY_BYTES;
      const size = bytes.readBigUInt64LE(at + 8);
      if (rva + size > BigInt(bytes.length))
        failure(
          `Memory64 range ${String(index)} is truncated or incomplete in the file.`,
        );
      const content = { offset: Number(rva), bytes: Number(size) };
      memoryContents.push({ range: content, what: "memory64 content" });
      memory.push({
        source: "memory64-list",
        descriptor_location: { offset: at, bytes: MEMORY_BYTES },
        start_address: hex(bytes.readBigUInt64LE(at)),
        bytes: hex(size),
        location: content,
      });
      rva += size;
    }
  }
  rejectOverlaps(memoryContents, true);

  let exception: WindowsMinidump["exception"] = null;
  const exceptionStream = byType.get(6);
  if (exceptionStream !== undefined) {
    if (exceptionStream.bytes < EXCEPTION_BYTES)
      failure("ExceptionStream is incomplete.");
    const at = exceptionStream.offset;
    const declared = bytes.readUInt32LE(at + 32);
    if (declared > EXCEPTION_PARAMETER_SLOTS)
      failure(
        `ExceptionStream declares ${String(declared)} parameters; the record holds at most ${String(EXCEPTION_PARAMETER_SLOTS)}.`,
      );
    exception = {
      location: exceptionStream,
      historical_thread_id: bytes.readUInt32LE(at),
      code: bytes.readUInt32LE(at + 8),
      flags: bytes.readUInt32LE(at + 12),
      nested_record: hex(bytes.readBigUInt64LE(at + 16)),
      address: hex(bytes.readBigUInt64LE(at + 24)),
      declared_parameters: declared,
      parameters: Array.from({ length: declared }, (_u, i) =>
        hex(bytes.readBigUInt64LE(at + 40 + i * 8)),
      ),
      context: readContext(at + 160, "Exception context"),
    };
  }
  signal?.throwIfAborted();

  const unknown = streams.filter(
    ({ interpretation }) => interpretation === "unknown",
  ).length;
  const limitations = [
    "Historical thread IDs and the exception thread ID are recorded metadata; they never select, attach to or describe a current process.",
    "Recorded module names are producer metadata; current file identity, symbols and CodeView/PDB matches are not resolved or downloaded.",
    "Only memory ranges described by MemoryList/Memory64List and thread stacks are present; all other address space is unknown, not absent.",
  ];
  if (system === null)
    limitations.push(
      "SystemInfoStream is absent; architecture and register layout are unknown.",
    );
  else if (!amd64)
    limitations.push(
      "Thread context bytes are located but registers are interpreted only for AMD64 dumps.",
    );
  if (unknown > 0)
    limitations.push(
      `${String(unknown)} stream(s) have uninterpreted types; their bytes are located but their meaning is unknown.`,
    );
  if (exception === null)
    limitations.push(
      "ExceptionStream is absent; no exception facts are claimed.",
    );
  if (amd64)
    limitations.push(
      "AMD64 register values are reported as recorded; ContextFlags validity per register class is not interpreted.",
    );

  return {
    artifact,
    format: "windows-minidump",
    header: {
      location: { offset: 0, bytes: HEADER_BYTES },
      version: versionWord & 0xffff,
      implementation_version: versionWord >>> 16,
      stream_count: streamCount,
      directory_location: directory,
      checksum: bytes.readUInt32LE(16),
      timestamp: bytes.readUInt32LE(20),
      flags: hex(bytes.readBigUInt64LE(24)),
    },
    streams,
    system,
    threads,
    exception,
    modules,
    memory,
    coverage: {
      status: "complete",
      examined_entries: examined,
      unknown_streams: unknown,
    },
    limitations,
  };
};

const readSystem = (
  bytes: Buffer,
  stream: WindowsMinidumpRange,
): NonNullable<WindowsMinidump["system"]> => {
  if (stream.bytes < SYSTEM_INFO_BYTES)
    failure("SystemInfoStream is incomplete.");
  const at = stream.offset;
  const architecture = bytes.readUInt16LE(at);
  return {
    location: stream,
    processor_architecture: architecture,
    architecture:
      (
        WINDOWS_MINIDUMP_ARCHITECTURES as Record<
          number,
          { name: "x86" | "arm" | "amd64" | "arm64" }
        >
      )[architecture]?.name ?? null,
    processor_level: bytes.readUInt16LE(at + 2),
    processor_revision: bytes.readUInt16LE(at + 4),
    processors: bytes[at + 6]!,
    product_type: bytes[at + 7]!,
    major_version: bytes.readUInt32LE(at + 8),
    minor_version: bytes.readUInt32LE(at + 12),
    build_number: bytes.readUInt32LE(at + 16),
    platform_id: bytes.readUInt32LE(at + 20),
  };
};

/** Non-identical overlapping ranges make the recorded layout ambiguous. */
const rejectOverlaps = (
  ranges: readonly { range: WindowsMinidumpRange; what: string }[],
  allowIdentical = false,
): void => {
  const sorted = ranges
    .filter(({ range }) => range.bytes > 0)
    .toSorted(
      (a, b) =>
        a.range.offset - b.range.offset || a.range.bytes - b.range.bytes,
    );
  let furthest = sorted[0];
  for (const current of sorted.slice(1)) {
    const previous = furthest!;
    const end = previous.range.offset + previous.range.bytes;
    const identical =
      previous.range.offset === current.range.offset &&
      previous.range.bytes === current.range.bytes;
    if (identical && allowIdentical) continue;
    if (current.range.offset < end)
      failure(
        `Overlapping ${previous.what} and ${current.what} ranges make the recorded layout ambiguous.`,
      );
    furthest = current;
  }
};
