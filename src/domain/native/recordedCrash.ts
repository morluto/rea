import { z } from "zod";

const hex = z.string().regex(/^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/);
const index = z.number().int().nonnegative();
const signed32 = z.number().int().min(-2147483648).max(2147483647);
const base64 = z
  .string()
  .regex(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/,
  );
const range = z.strictObject({ offset: hex, bytes: hex });
const diagnostics = z.strictObject({
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
});
// Exact b"CORE\0"; a lossy display label cannot establish the Linux note ABI.
const LINUX_CORE_OWNER_BASE64 = "Q09SRQA=";

/** Complete register identities in the supported Linux amd64 PRSTATUS ABI order. */
export const RECORDED_LINUX_AMD64_REGISTERS: readonly string[] = [
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
const supportedRegisters = new Set(RECORDED_LINUX_AMD64_REGISTERS);

/** Select an explicit recording and optionally request debugger-derived mapping context. */
export const inspectRecordedCrashInputSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .describe("Absolute filesystem path to a supplied Linux ELF core"),
  include_debugger_context: z
    .boolean()
    .default(false)
    .describe(
      "Add core-only mapping candidates through caller-supplied GDB/pwndbg",
    ),
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
  architecture: z.literal("x86_64-little-endian"),
  target_execution: z.literal("not-performed"),
  live_process_identity: z.literal("unknown"),
  segments: z.array(
    z.strictObject({
      index,
      type: z.union([z.string(), index]),
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
      recorded_current_signal: z.number().int().min(-32768).max(32767),
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

/** Validate the next consumer's file ranges, note links and register representations. */
export const recordedCrashSchema = recordedCrashObjectSchema.superRefine(
  (value, context) => {
    const fail = (message: string) =>
      context.addIssue({ code: "custom", message });
    const within = (
      item: z.output<typeof range>,
      start = 0n,
      end = BigInt(value.artifact.bytes),
    ) => {
      const offset = BigInt(item.offset);
      const bytes = BigInt(item.bytes);
      return offset >= start && offset <= end && bytes <= end - offset;
    };
    for (const [position, segment] of value.segments.entries()) {
      if (position !== segment.index || !within(segment.header_location))
        fail("Invalid original segment identity or header range.");
      if (
        segment.file_backing === "file" &&
        !within({ offset: segment.offset, bytes: segment.file_size })
      )
        fail("Recorded segment exceeds artifact bytes.");
      if (
        segment.type === "PT_LOAD" &&
        BigInt(segment.file_size) > BigInt(segment.memory_size)
      )
        fail("Recorded PT_LOAD file size exceeds memory size.");
    }
    for (const [position, note] of value.notes.entries()) {
      const segment = value.segments[note.segment_index];
      if (position !== note.index || segment?.type !== "PT_NOTE") {
        fail("Invalid original note identity or segment reference.");
        continue;
      }
      const decodedLength = (raw: string) =>
        BigInt(
          (raw.length / 4) * 3 -
            (raw.endsWith("==") ? 2 : raw.endsWith("=") ? 1 : 0),
        );
      if (
        decodedLength(note.owner_bytes_base64) !==
          BigInt(note.owner_location.bytes) ||
        decodedLength(note.descriptor_bytes_base64) !==
          BigInt(note.descriptor_location.bytes)
      )
        fail("Raw note lengths differ from their source ranges.");
      const start = BigInt(segment.offset);
      const end = start + BigInt(segment.file_size);
      if (
        !within(note.location, start, end) ||
        !within(
          note.owner_location,
          BigInt(note.location.offset),
          BigInt(note.location.offset) + BigInt(note.location.bytes),
        ) ||
        !within(
          note.descriptor_location,
          BigInt(note.location.offset),
          BigInt(note.location.offset) + BigInt(note.location.bytes),
        )
      )
        fail("Note source ranges exceed their recorded segment.");
    }
    for (const padding of value.note_padding) {
      const segment = value.segments[padding.segment_index];
      if (
        segment?.type !== "PT_NOTE" ||
        !within(
          padding.location,
          BigInt(segment.offset),
          BigInt(segment.offset) + BigInt(segment.file_size),
        )
      )
        fail("Invalid recorded note padding range.");
    }
    for (const [kind, rows] of [
      ["NT_PRSTATUS", value.threads],
      ["NT_SIGINFO", value.signals],
    ] as const) {
      const matchingNotes = value.notes.filter(
        (note) =>
          note.type === kind &&
          note.owner_bytes_base64 === LINUX_CORE_OWNER_BASE64,
      );
      if (
        rows.length !== matchingNotes.length ||
        new Set(rows.map(({ note_index }) => note_index)).size !== rows.length
      )
        fail(
          "Each supported raw note requires exactly one corresponding interpretation.",
        );
    }
    for (const thread of value.threads) {
      const note = value.notes[thread.note_index];
      if (
        note?.type !== "NT_PRSTATUS" ||
        note.owner_display !== "CORE" ||
        note.owner_bytes_base64 !== LINUX_CORE_OWNER_BASE64
      ) {
        fail("Thread references a different note kind.");
        continue;
      }
      if (
        thread.registers.length !== RECORDED_LINUX_AMD64_REGISTERS.length ||
        !thread.registers.every(({ name }) => supportedRegisters.has(name)) ||
        new Set(thread.registers.map(({ name }) => name)).size !==
          thread.registers.length
      )
        fail(
          "Each recorded thread requires every supported register exactly once.",
        );
      for (const register of thread.registers)
        if (
          BigInt(register.location.bytes) !== 8n ||
          !within(
            register.location,
            BigInt(note.descriptor_location.offset),
            BigInt(note.descriptor_location.offset) +
              BigInt(note.descriptor_location.bytes),
          )
        )
          fail("Register source exceeds its descriptor.");
    }
    for (const signal of value.signals) {
      if (
        value.notes[signal.note_index]?.type !== "NT_SIGINFO" ||
        value.notes[signal.note_index]?.owner_display !== "CORE" ||
        value.notes[signal.note_index]?.owner_bytes_base64 !==
          LINUX_CORE_OWNER_BASE64
      )
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
    if (value.debugger.status === "available")
      for (const map of value.debugger.maps) {
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
          fail(
            "Unreported or unfamiliar map flags require unknown permissions.",
          );
      }
  },
);

export type InspectRecordedCrashInput = z.output<
  typeof inspectRecordedCrashInputSchema
>;
export type RecordedCrash = z.output<typeof recordedCrashSchema>;
