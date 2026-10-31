import { z } from "zod";

import type { BinaryArchitecture } from "../binaryTargetTypes.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";

const uint32 = z.number().int().min(0).max(0xffffffff);
const count = z.number().int().nonnegative();
const hex64 = z.string().regex(/^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
/** Validated original file range; offsets are RVAs from the start of the dump. */
const range = z.strictObject({ offset: count, bytes: count });

/** Minidump stream types interpreted by the initial profile. */
export const WINDOWS_MINIDUMP_INTERPRETED_STREAMS = {
  3: "ThreadListStream",
  4: "ModuleListStream",
  5: "MemoryListStream",
  6: "ExceptionStream",
  7: "SystemInfoStream",
  9: "Memory64ListStream",
} as const satisfies Readonly<Record<number, string>>;

/** PROCESSOR_ARCHITECTURE_* values whose identity is named, not interpreted. */
export const WINDOWS_MINIDUMP_ARCHITECTURES = {
  0: { name: "x86", evidence: "x86" },
  5: { name: "arm", evidence: "arm" },
  9: { name: "amd64", evidence: "x86_64" },
  12: { name: "arm64", evidence: "arm64" },
} as const satisfies Readonly<
  Record<number, { name: string; evidence: BinaryArchitecture }>
>;

/** AMD64 CONTEXT integer, flags and segment fields with their original offsets and widths. */
export const WINDOWS_MINIDUMP_AMD64_CONTEXT = [
  ["context_flags", 0x30, 4],
  ["mxcsr", 0x34, 4],
  ["cs", 0x38, 2],
  ["ds", 0x3a, 2],
  ["es", 0x3c, 2],
  ["fs", 0x3e, 2],
  ["gs", 0x40, 2],
  ["ss", 0x42, 2],
  ["eflags", 0x44, 4],
  ["rax", 0x78, 8],
  ["rcx", 0x80, 8],
  ["rdx", 0x88, 8],
  ["rbx", 0x90, 8],
  ["rsp", 0x98, 8],
  ["rbp", 0xa0, 8],
  ["rsi", 0xa8, 8],
  ["rdi", 0xb0, 8],
  ["r8", 0xb8, 8],
  ["r9", 0xc0, 8],
  ["r10", 0xc8, 8],
  ["r11", 0xd0, 8],
  ["r12", 0xd8, 8],
  ["r13", 0xe0, 8],
  ["r14", 0xe8, 8],
  ["r15", 0xf0, 8],
  ["rip", 0xf8, 8],
] as const;
/** Bytes through `Rip`; complete AMD64 CONTEXT records are 1232 bytes. */
export const WINDOWS_MINIDUMP_AMD64_CONTEXT_MIN_BYTES = 0x100;

export const MAX_INSPECT_MINIDUMP_FILE_BYTES = 1073741824;
export const MAX_INSPECT_MINIDUMP_ENTRIES = 1048576;

/** Explicit recorded dump selection with independent read and inventory budgets. */
export const inspectWindowsMinidumpInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute filesystem path to a supplied Windows minidump (.dmp)",
  ),
  max_file_bytes: z
    .number()
    .int()
    .min(32)
    .max(MAX_INSPECT_MINIDUMP_FILE_BYTES)
    .default(268435456)
    .describe("Maximum stable artifact bytes to read (default 256 MiB)"),
  max_entries: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_MINIDUMP_ENTRIES)
    .default(65536)
    .describe(
      "Maximum directory, thread, module and memory descriptors to examine; exceeding it fails without partial success",
    ),
});

const context = z.strictObject({
  location: range,
  /** Interpreted only for AMD64 dumps with a context covering `Rip`. */
  registers: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        value: hex64,
        location: range,
      }),
    )
    .nullable(),
});

const memoryDescriptor = z.strictObject({
  source: z.enum(["memory-list", "memory64-list"]),
  descriptor_location: range,
  start_address: hex64,
  bytes: hex64,
  location: range,
});

/** Recorded minidump facts; historical IDs and module names never identify current processes or files. */
export const windowsMinidumpSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256,
    bytes: count,
  }),
  format: z.literal("windows-minidump"),
  header: z.strictObject({
    location: range,
    version: uint32,
    implementation_version: uint32,
    stream_count: uint32,
    directory_location: range,
    checksum: uint32,
    timestamp: uint32,
    flags: hex64,
  }),
  streams: z.array(
    z.strictObject({
      index: count,
      type: uint32,
      type_name: z.string().nullable(),
      entry_location: range,
      location: range,
      interpretation: z.enum(["interpreted", "unused", "unknown"]),
    }),
  ),
  system: z
    .strictObject({
      location: range,
      processor_architecture: uint32,
      architecture: z.enum(["x86", "arm", "amd64", "arm64"]).nullable(),
      processor_level: uint32,
      processor_revision: uint32,
      processors: uint32,
      product_type: uint32,
      major_version: uint32,
      minor_version: uint32,
      build_number: uint32,
      platform_id: uint32,
    })
    .nullable(),
  threads: z.array(
    z.strictObject({
      index: count,
      entry_location: range,
      historical_thread_id: uint32,
      suspend_count: uint32,
      priority_class: uint32,
      priority: uint32,
      teb: hex64,
      stack: z.strictObject({
        start_address: hex64,
        location: range,
      }),
      context,
    }),
  ),
  exception: z
    .strictObject({
      location: range,
      historical_thread_id: uint32,
      code: uint32,
      flags: uint32,
      nested_record: hex64,
      address: hex64,
      parameters: z.array(hex64).max(15),
      declared_parameters: uint32,
      context,
    })
    .nullable(),
  modules: z.array(
    z.strictObject({
      index: count,
      entry_location: range,
      base_address: hex64,
      image_bytes: uint32,
      checksum: uint32,
      timestamp: uint32,
      recorded_name: z.string(),
      recorded_name_utf16le_hex: z.string().regex(/^(?:[0-9a-f]{4})*$/),
      name_location: range,
      cv_record_location: range,
      misc_record_location: range,
    }),
  ),
  memory: z.array(memoryDescriptor),
  coverage: z.strictObject({
    status: z.literal("complete"),
    examined_entries: count,
    unknown_streams: count,
  }),
  limitations: z.array(z.string()),
});

export type InspectWindowsMinidumpInput = z.output<
  typeof inspectWindowsMinidumpInputSchema
>;
export type WindowsMinidump = z.output<typeof windowsMinidumpSchema>;
export type WindowsMinidumpRange = z.output<typeof range>;
