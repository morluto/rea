import { z } from "zod";
import { pwntoolsProducerLimitsField } from "./pwntoolsResourceLimits.js";

import type { BinaryArchitecture } from "../binaryTargetTypes.js";
import { pwntoolsTimeoutField } from "./nativeDeadlines.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";
import { canonicalBase64Schema } from "../stringPatterns.js";
import { recordedNoteCoverageIssues } from "./recordedCrashNoteCoverage.js";

const hex = z
  .string()
  .regex(/^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/, { abort: true });
const index = z.int().nonnegative();
const signed32 = z.int().min(-2147483648).max(2147483647);
const base64 = canonicalBase64Schema;
const range = z.strictObject({ offset: hex, bytes: hex });
const diagnostics = z.strictObject({
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
});
// Exact b"CORE\0"; a lossy display label cannot establish the Linux note ABI.
const LINUX_CORE_OWNER_BASE64 = "Q09SRQA=";

/** Source identity controls interpretation; decoder labels are display facts. */
export const isLinuxCoreNote = (
  note:
    | { readonly owner_bytes_base64: string; readonly type_id: number }
    | undefined,
  type: number,
): boolean =>
  note?.owner_bytes_base64 === LINUX_CORE_OWNER_BASE64 && note.type_id === type;

/** Complete register identities in the supported Linux amd64 PRSTATUS ABI order. */
const RECORDED_LINUX_AMD64_REGISTERS: readonly string[] = [
  "r15",
  "r14",
  "r13",
  "r12",
  "rbp",
  "rbx",
  "r11",
  "r10",
  "r9",
  "r8",
  "rax",
  "rcx",
  "rdx",
  "rsi",
  "rdi",
  "orig_rax",
  "rip",
  "cs",
  "eflags",
  "rsp",
  "ss",
  "fs_base",
  "gs_base",
  "ds",
  "es",
  "fs",
  "gs",
];
const RECORDED_LINUX_AARCH64_REGISTERS: readonly string[] = [
  "x0",
  "x1",
  "x2",
  "x3",
  "x4",
  "x5",
  "x6",
  "x7",
  "x8",
  "x9",
  "x10",
  "x11",
  "x12",
  "x13",
  "x14",
  "x15",
  "x16",
  "x17",
  "x18",
  "x19",
  "x20",
  "x21",
  "x22",
  "x23",
  "x24",
  "x25",
  "x26",
  "x27",
  "x28",
  "x29",
  "x30",
  "sp",
  "pc",
  "pstate",
];

/** Recorded-core architectures whose Linux note ABI is interpreted. */
export const RECORDED_LINUX_CORE_ARCHITECTURES = [
  "x86_64-little-endian",
  "aarch64-little-endian",
] as const;

export type RecordedCrashArchitecture =
  (typeof RECORDED_LINUX_CORE_ARCHITECTURES)[number];

/**
 * ABI facts for one recorded-core architecture, measured from unchanged pwntools
 * 4.15.0 `elf_prstatus_*` and `user_regs_struct_*` structures and mirrored by
 * `bridge/pwntools/recorded_crash_impl.py`. Both profiles place `pr_cursig` at
 * 12, `pr_pid` at 32 and the register window at 112; the ELF machine, the window
 * contents and the Evidence CPU family differ per profile.
 */
export const RECORDED_LINUX_CORE_PROFILES: Record<
  RecordedCrashArchitecture,
  {
    readonly machine: number;
    readonly evidenceArchitecture: BinaryArchitecture;
    readonly registers: readonly string[];
    readonly registerBytes: number;
    readonly registerOffset: number;
    readonly prstatusBytes: number;
  }
> = {
  "x86_64-little-endian": {
    machine: 62,
    evidenceArchitecture: "x86_64",
    registers: RECORDED_LINUX_AMD64_REGISTERS,
    registerBytes: 8,
    registerOffset: 112,
    prstatusBytes: 336,
  },
  "aarch64-little-endian": {
    machine: 183,
    evidenceArchitecture: "arm64",
    registers: RECORDED_LINUX_AARCH64_REGISTERS,
    registerBytes: 8,
    registerOffset: 112,
    prstatusBytes: 392,
  },
};

const recordedCoreRegisterIndices: Record<
  RecordedCrashArchitecture,
  ReadonlyMap<string, number>
> = {
  "x86_64-little-endian": new Map(
    RECORDED_LINUX_AMD64_REGISTERS.map((name, idx) => [name, idx]),
  ),
  "aarch64-little-endian": new Map(
    RECORDED_LINUX_AARCH64_REGISTERS.map((name, idx) => [name, idx]),
  ),
};

/** Select an explicit recording and optionally request debugger-derived mapping context. */
export const inspectRecordedCrashInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute filesystem path to a supplied Linux ELF core",
  ),
  include_debugger_context: z
    .boolean()
    .default(false)
    .describe(
      "Add core-only mapping candidates through caller-supplied GDB/pwndbg",
    ),
  pwntools_timeout_ms: pwntoolsTimeoutField,
  producer_limits: pwntoolsProducerLimitsField,
});

/** Debugger map candidates preserve reported flags; zero does not establish absent permissions. */
export const recordedCrashDebuggerSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("not-requested") }),
  z.strictObject({
    status: z.literal("available"),
    gdb_version: z.string().min(1),
    pwndbg_version: z.string().min(1),
    connection: z.literal("core"),
    executable: z.null(),
    historical_pid: signed32,
    reported_limits: z.strictObject({
      address_space_bytes: index,
      cpu_seconds: index,
      file_size_bytes: index,
    }),
    maps: z.array(
      z.strictObject({
        start: hex,
        end: hex,
        offset: hex,
        reported_flags: index,
        permissions: z
          .strictObject({
            read: z.boolean(),
            write: z.boolean(),
            execute: z.boolean(),
          })
          .nullable(),
        pathname_display: z.string(),
        current_file_identity: z.literal("unknown"),
      }),
    ),
    confidence: z.literal("derived"),
    completeness: z.literal("unknown"),
    diagnostics,
  }),
]);

/** Portable recorded observations; registers and source coordinates remain lossless. */
const recordedCrashObjectSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: index,
  }),
  format: z.literal("elf-core"),
  architecture: z.enum(RECORDED_LINUX_CORE_ARCHITECTURES),
  target_execution: z.literal("not-performed"),
  live_process_identity: z.literal("unknown"),
  segments: z.array(
    z.strictObject({
      index,
      type: z.union([z.string(), index]),
      type_id: index.max(0xffffffff),
      header_location: range,
      offset: hex,
      file_size: hex,
      memory_size: hex,
      virtual_address: hex,
      physical_address: hex,
      alignment: hex,
      flags: hex,
      file_backing: z.enum(["file", "none"]),
    }),
  ),
  notes: z.array(
    z.strictObject({
      index,
      segment_index: index,
      type: z.union([z.string(), index]),
      type_id: index.max(0xffffffff),
      location: range,
      owner_location: range,
      owner_bytes_base64: base64,
      owner_display: z.string().nullable(),
      descriptor_location: range,
      descriptor_bytes_base64: base64,
    }),
  ),
  note_padding: z.array(
    z.strictObject({
      segment_index: index,
      location: range,
      bytes_base64: base64,
    }),
  ),
  threads: z.array(
    z.strictObject({
      note_index: index,
      historical_pid: signed32,
      recorded_current_signal: z.int().min(-32768).max(32767),
      registers: z.array(
        z.strictObject({
          name: z.string().min(1),
          value: hex,
          location: range,
        }),
      ),
    }),
  ),
  signals: z.array(
    z.strictObject({
      note_index: index,
      number: signed32,
      code: signed32,
      errno: signed32,
      fault_address: hex.nullable(),
      fault_address_meaning: z.enum(["recorded-sigsegv-address", "unknown"]),
      thread_association: z.literal("unknown"),
    }),
  ),
  debugger: recordedCrashDebuggerSchema,
  note_interpretation_completeness: z.literal("unknown"),
  decoder_diagnostics: diagnostics,
  diagnostics,
  limitations: z.array(z.string()),
});

/** Provider payload excludes identity and diagnostics bound by the owned snapshot boundary. */
export const recordedCrashPayloadSchema = recordedCrashObjectSchema.omit({
  artifact: true,
  diagnostics: true,
  debugger: true,
  decoder_diagnostics: true,
});

const recordedCrashMetadataSchema = recordedCrashObjectSchema.pick({
  artifact: true,
  debugger: true,
  decoder_diagnostics: true,
  diagnostics: true,
});

const withinRange = (
  item: z.output<typeof range>,
  start: bigint,
  end: bigint,
): boolean => {
  if (
    item.offset.length <= 15 &&
    item.bytes.length <= 15 &&
    end <= 0xfffffffffffffn
  ) {
    const startNum = Number(start);
    const endNum = Number(end);
    const offset = Number(item.offset);
    const bytes = Number(item.bytes);
    return offset >= startNum && offset <= endNum && bytes <= endNum - offset;
  }
  const offset = BigInt(item.offset);
  const bytes = BigInt(item.bytes);
  return offset >= start && offset <= end && bytes <= end - offset;
};

const hasUniqueNoteIndices = (
  rows: readonly { readonly note_index: number }[],
): boolean => {
  if (rows.length <= 1) return true;
  const seen = new Set<number>();
  for (let i = 0; i < rows.length; i += 1) {
    const noteIndex = rows[i]!.note_index;
    if (seen.has(noteIndex)) return false;
    seen.add(noteIndex);
  }
  return true;
};

const hasExactProfileRegisters = (
  registers: RecordedCrash["threads"][number]["registers"],
  registerIndices: ReadonlyMap<string, number>,
  expectedCount: number,
): boolean => {
  if (registers.length !== expectedCount) return false;
  let seenLo = 0;
  let seenHi = 0;
  for (let i = 0; i < registers.length; i += 1) {
    const bitIndex = registerIndices.get(registers[i]!.name);
    if (bitIndex === undefined) return false;
    if (bitIndex < 32) {
      const mask = 1 << bitIndex;
      if ((seenLo & mask) !== 0) return false;
      seenLo |= mask;
    } else {
      const mask = 1 << (bitIndex - 32);
      if ((seenHi & mask) !== 0) return false;
      seenHi |= mask;
    }
  }
  return true;
};

const validateRecordedCrashDebuggerMaps = (
  debuggerContext: z.output<typeof recordedCrashDebuggerSchema>,
  fail: (message: string) => void,
): void => {
  if (debuggerContext.status !== "available") return;
  for (const map of debuggerContext.maps) {
    if (BigInt(map.end) < BigInt(map.start))
      fail("Debugger mapping end precedes its start.");
    if (
      map.permissions !== null &&
      (map.permissions.read !== Boolean(map.reported_flags & 4) ||
        map.permissions.write !== Boolean(map.reported_flags & 2) ||
        map.permissions.execute !== Boolean(map.reported_flags & 1))
    )
      fail("Mapping permissions differ from reported flags.");
    if (
      (map.reported_flags === 0 || map.reported_flags > 7) !==
      (map.permissions === null)
    )
      fail("Unreported or unfamiliar map flags require unknown permissions.");
  }
};

const validateRecordedCrashSegmentsAndNotes = (
  value: z.output<typeof recordedCrashObjectSchema>,
  fail: (message: string) => void,
): { threadNotes: number; signalNotes: number } => {
  const artifactBytes = BigInt(value.artifact.bytes);
  for (const [position, segment] of value.segments.entries()) {
    if (typeof segment.type === "number" && segment.type !== segment.type_id)
      fail("Numeric segment type differs from its source identity.");
    if (
      position !== segment.index ||
      !withinRange(segment.header_location, 0n, artifactBytes)
    )
      fail("Invalid original segment identity or header range.");
    if (
      segment.file_backing === "file" &&
      !withinRange(
        { offset: segment.offset, bytes: segment.file_size },
        0n,
        artifactBytes,
      )
    )
      fail("Recorded segment exceeds artifact bytes.");
    if (
      segment.type_id === 1 &&
      BigInt(segment.file_size) > BigInt(segment.memory_size)
    )
      fail("Recorded PT_LOAD file size exceeds memory size.");
  }
  let threadNotes = 0;
  let signalNotes = 0;
  for (const [position, note] of value.notes.entries()) {
    const segment = value.segments[note.segment_index];
    if (position !== note.index || segment?.type_id !== 4) {
      fail("Invalid original note identity or segment reference.");
      continue;
    }
    let ownerLen: number;
    let ownerDisplay: string | null;
    if (note.owner_bytes_base64 === LINUX_CORE_OWNER_BASE64) {
      ownerLen = 5;
      ownerDisplay = "CORE";
      if (note.type_id === 1) threadNotes += 1;
      else if (note.type_id === 0x53494749) signalNotes += 1;
    } else {
      const ownerBytes = Buffer.from(note.owner_bytes_base64, "base64");
      const terminator = ownerBytes.indexOf(0);
      if (ownerBytes.length > 0 && terminator < 0)
        fail("Note owner display differs from its retained bytes.");
      ownerLen = ownerBytes.length;
      ownerDisplay =
        ownerLen === 0
          ? null
          : ownerBytes.subarray(0, terminator).toString("utf8");
    }
    if (note.owner_display !== ownerDisplay)
      fail("Note owner display differs from its retained bytes.");
    if (typeof note.type === "number" && note.type !== note.type_id)
      fail("Numeric note type differs from its source identity.");
    if (
      note.owner_bytes_base64 !== LINUX_CORE_OWNER_BASE64 &&
      note.type !== note.type_id
    )
      fail(
        "Uninterpreted note owners must retain their numeric type identity.",
      );
    if (
      BigInt(ownerLen) !== BigInt(note.owner_location.bytes) ||
      BigInt(Buffer.byteLength(note.descriptor_bytes_base64, "base64")) !==
        BigInt(note.descriptor_location.bytes)
    )
      fail("Raw note lengths differ from their source ranges.");
    const start = BigInt(segment.offset);
    const end = start + BigInt(segment.file_size);
    const noteStart = BigInt(note.location.offset);
    const noteEnd = noteStart + BigInt(note.location.bytes);
    if (
      !withinRange(note.location, start, end) ||
      !withinRange(note.owner_location, noteStart, noteEnd) ||
      !withinRange(note.descriptor_location, noteStart, noteEnd)
    )
      fail("Note source ranges exceed their recorded segment.");
  }
  return { threadNotes, signalNotes };
};

const validateRecordedCrashInvariants = (
  value: z.output<typeof recordedCrashObjectSchema>,
  fail: (message: string) => void,
): void => {
  for (const issue of recordedNoteCoverageIssues(
    value.segments,
    value.notes,
    value.note_padding,
  ))
    fail(issue);
  const { threadNotes, signalNotes } = validateRecordedCrashSegmentsAndNotes(
    value,
    fail,
  );
  for (const padding of value.note_padding) {
    const segment = value.segments[padding.segment_index];
    if (
      segment?.type_id !== 4 ||
      !withinRange(
        padding.location,
        BigInt(segment.offset),
        BigInt(segment.offset) + BigInt(segment.file_size),
      )
    )
      fail("Invalid recorded note padding range.");
  }
  if (
    value.threads.length !== threadNotes ||
    !hasUniqueNoteIndices(value.threads) ||
    value.signals.length !== signalNotes ||
    !hasUniqueNoteIndices(value.signals)
  )
    fail(
      "Each supported raw note requires exactly one corresponding interpretation.",
    );
  const profile = RECORDED_LINUX_CORE_PROFILES[value.architecture];
  const registerIndices = recordedCoreRegisterIndices[value.architecture];
  for (const thread of value.threads) {
    const note = value.notes[thread.note_index];
    if (note === undefined || !isLinuxCoreNote(note, 1)) {
      fail("Thread references a different note kind.");
      continue;
    }
    if (
      !hasExactProfileRegisters(
        thread.registers,
        registerIndices,
        profile.registers.length,
      )
    )
      fail(
        "Each recorded thread requires every supported register exactly once.",
      );
    const descStart = BigInt(note.descriptor_location.offset);
    const descEnd = descStart + BigInt(note.descriptor_location.bytes);
    for (const register of thread.registers)
      if (
        BigInt(register.location.bytes) !== BigInt(profile.registerBytes) ||
        !withinRange(register.location, descStart, descEnd)
      )
        fail("Register source exceeds its descriptor.");
  }
  for (const signal of value.signals) {
    if (!isLinuxCoreNote(value.notes[signal.note_index], 0x53494749))
      fail("Signal references a different note kind.");
    const known =
      signal.number === 11 && (signal.code === 1 || signal.code === 2);
    if (
      known !== (signal.fault_address !== null) ||
      (signal.fault_address !== null) !==
        (signal.fault_address_meaning === "recorded-sigsegv-address")
    )
      fail("Signal union meaning does not match recorded SIGSEGV code.");
  }
  validateRecordedCrashDebuggerMaps(value.debugger, fail);
};

/** Validate the next consumer's file ranges, note links and register representations. */
export const recordedCrashSchema = recordedCrashObjectSchema.superRefine(
  (value, context) => {
    validateRecordedCrashInvariants(value, (message) =>
      context.addIssue({ code: "custom", message }),
    );
  },
);

export type InspectRecordedCrashInput = z.output<
  typeof inspectRecordedCrashInputSchema
>;
export type RecordedCrash = z.output<typeof recordedCrashSchema>;

export type ProjectedRecordedCrashResult =
  | { readonly success: true; readonly data: RecordedCrash }
  | { readonly success: false; readonly error: z.ZodError };

/** Validate envelope fields + cross-field invariants for an already-parsed payload. */
export const safeParseProjectedRecordedCrash = (
  payload: z.output<typeof recordedCrashPayloadSchema>,
  metadata: {
    readonly artifact: unknown;
    readonly debugger: unknown;
    readonly decoder_diagnostics: unknown;
    readonly diagnostics: unknown;
  },
): ProjectedRecordedCrashResult => {
  const checkedMeta = recordedCrashMetadataSchema.safeParse(metadata);
  if (!checkedMeta.success) return { success: false, error: checkedMeta.error };
  const combined: RecordedCrash = { ...payload, ...checkedMeta.data };
  const issues: z.core.$ZodIssueCustom[] = [];
  validateRecordedCrashInvariants(combined, (message) => {
    issues.push({ code: "custom", message, path: [] });
  });
  if (issues.length > 0)
    return { success: false, error: new z.ZodError(issues) };
  return { success: true, data: combined };
};

/** Validate only debugger enrichment + diagnostics on an already-validated RecordedCrash. */
export const safeParseRecordedCrashDebuggerEnrichment = (
  base: RecordedCrash,
  debuggerContext: unknown,
  diagnosticsInput: unknown,
): ProjectedRecordedCrashResult => {
  const checkedDebugger =
    recordedCrashDebuggerSchema.safeParse(debuggerContext);
  if (!checkedDebugger.success)
    return { success: false, error: checkedDebugger.error };
  const checkedDiagnostics =
    recordedCrashObjectSchema.shape.diagnostics.safeParse(diagnosticsInput);
  if (!checkedDiagnostics.success)
    return { success: false, error: checkedDiagnostics.error };
  const issues: z.core.$ZodIssueCustom[] = [];
  validateRecordedCrashDebuggerMaps(checkedDebugger.data, (message) => {
    issues.push({ code: "custom", message, path: [] });
  });
  if (issues.length > 0)
    return { success: false, error: new z.ZodError(issues) };
  return {
    success: true,
    data: {
      ...base,
      debugger: checkedDebugger.data,
      diagnostics: checkedDiagnostics.data,
    },
  };
};

/** Validated basic core evidence retained when requested debugger enrichment fails. */
export type RecordedCrashPartialObservation = Omit<
  RecordedCrash,
  "debugger"
> & {
  readonly debugger: {
    readonly status: "unavailable";
    readonly requested: true;
  };
};
