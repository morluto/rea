import type { RecordedCrash } from "../../../src/domain/native/recordedCrash.js";

/** Source-owned observation seam; these bytes do not simulate a verified ELF engine. */
export const recordedCrashFixture = (
  path = "/artifacts/source-owned.core",
): RecordedCrash => {
  const descriptor = Buffer.alloc(336);
  descriptor.writeInt32LE(123, 32);
  descriptor.writeInt16LE(11, 12);
  descriptor.writeBigUInt64LE(0x1122334455667788n, 224);
  return {
    artifact: { path, sha256: "a".repeat(64), bytes: 512 },
    format: "elf-core",
    architecture: "x86_64-little-endian",
    target_execution: "not-performed",
    live_process_identity: "unknown",
    segments: [
      {
        index: 0,
        type: "PT_NOTE",
        header_location: { offset: "0x40", bytes: "0x38" },
        offset: "0x80",
        file_size: "0x164",
        memory_size: "0x0",
        virtual_address: "0x0",
        physical_address: "0x0",
        alignment: "0x4",
        flags: "0x0",
        file_backing: "file",
      },
    ],
    notes: [
      {
        index: 0,
        segment_index: 0,
        type: "NT_PRSTATUS",
        location: { offset: "0x80", bytes: "0x164" },
        owner_location: { offset: "0x8c", bytes: "0x5" },
        owner_bytes_base64: Buffer.from("CORE\0").toString("base64"),
        owner_display: "CORE",
        descriptor_location: { offset: "0x94", bytes: "0x150" },
        descriptor_bytes_base64: descriptor.toString("base64"),
      },
    ],
    note_padding: [],
    threads: [
      {
        note_index: 0,
        historical_pid: 123,
        recorded_current_signal: 11,
        registers: [
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
        ].map((name, index) => ({
          name,
          value: name === "rdi" ? "0x1122334455667788" : "0x0",
          location: {
            offset: `0x${(148 + 112 + index * 8).toString(16)}`,
            bytes: "0x8",
          },
        })),
      },
    ],
    signals: [],
    debugger: { status: "not-requested" },
    note_interpretation_completeness: "unknown",
    decoder_diagnostics: {
      stdout: "decoder diagnostic",
      stderr: "",
      truncated: false,
    },
    diagnostics: { stdout: "decoder diagnostic", stderr: "", truncated: false },
    limitations: ["Historical PID is recorded metadata."],
  };
};

/** Source-owned SIGSEGV descriptor for scalar/source binding regressions. */
export const recordedCrashSignalFixture = (path?: string): RecordedCrash => {
  const value = recordedCrashFixture(path);
  const descriptor = Buffer.alloc(32);
  descriptor.writeInt32LE(11, 0);
  descriptor.writeInt32LE(-2, 4);
  descriptor.writeInt32LE(1, 8);
  descriptor.writeBigUInt64LE(0x1122334455667788n, 16);
  value.artifact.bytes = 640;
  value.segments = value.segments.map((segment) => ({
    ...segment,
    file_size: "0x198",
  }));
  value.notes.push({
    index: 1,
    segment_index: 0,
    type: "NT_SIGINFO",
    location: { offset: "0x1e4", bytes: "0x34" },
    owner_location: { offset: "0x1f0", bytes: "0x5" },
    owner_bytes_base64: Buffer.from("CORE\0").toString("base64"),
    owner_display: "CORE",
    descriptor_location: { offset: "0x1f8", bytes: "0x20" },
    descriptor_bytes_base64: descriptor.toString("base64"),
  });
  value.signals.push({
    note_index: 1,
    number: 11,
    code: 1,
    errno: -2,
    fault_address: "0x1122334455667788",
    fault_address_meaning: "recorded-sigsegv-address",
    thread_association: "unknown",
  });
  return value;
};

/** Construct only the original byte ranges consumed by the provider protocol tests. */
export const recordedCrashFixtureBytes = (value: RecordedCrash): Buffer => {
  const bytes = Buffer.alloc(value.artifact.bytes);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes.writeUInt16LE(4, 16);
  bytes.writeUInt16LE(62, 18);
  bytes.writeBigUInt64LE(64n, 32);
  bytes.writeUInt16LE(56, 54);
  bytes.writeUInt16LE(value.segments.length, 56);
  for (const segment of value.segments) {
    const start = Number(BigInt(segment.header_location.offset));
    bytes.writeUInt32LE(segment.type === "PT_NOTE" ? 4 : 0, start);
    bytes.writeUInt32LE(Number(BigInt(segment.flags)), start + 4);
    for (const [field, offset] of [
      [segment.offset, 8],
      [segment.virtual_address, 16],
      [segment.physical_address, 24],
      [segment.file_size, 32],
      [segment.memory_size, 40],
      [segment.alignment, 48],
    ] as const)
      bytes.writeBigUInt64LE(BigInt(field), start + offset);
  }
  for (const note of value.notes) {
    const start = Number(BigInt(note.location.offset));
    bytes.writeUInt32LE(Number(BigInt(note.owner_location.bytes)), start);
    bytes.writeUInt32LE(
      Number(BigInt(note.descriptor_location.bytes)),
      start + 4,
    );
    bytes.writeUInt32LE(
      note.type === "NT_PRSTATUS" ? 1 : 0x53494749,
      start + 8,
    );
    Buffer.from(note.owner_bytes_base64, "base64").copy(
      bytes,
      Number(BigInt(note.owner_location.offset)),
    );
    Buffer.from(note.descriptor_bytes_base64, "base64").copy(
      bytes,
      Number(BigInt(note.descriptor_location.offset)),
    );
  }
  return bytes;
};

export const RECORDED_CRASH_TEST_PROVIDER = {
  id: "fixture-recorded-core",
  name: "Source-owned recorded-core seam",
  version: "1",
} as const;

/** Source-owned debugger representation with deliberately unreported permission flags. */
export const recordedCrashDebuggerFixture = (): Extract<
  RecordedCrash["debugger"],
  { status: "available" }
> => ({
  status: "available",
  gdb_version: "source seam",
  pwndbg_version: "source seam",
  connection: "core",
  executable: null,
  historical_pid: 123,
  reported_limits: {
    address_space_bytes: 3221225472,
    cpu_seconds: 30,
    file_size_bytes: 67108864,
  },
  maps: [
    {
      start: "0x1000",
      end: "0x2000",
      offset: "0x0",
      reported_flags: 0,
      permissions: null,
      pathname_display: "recorded/path",
      current_file_identity: "unknown",
    },
  ],
  confidence: "derived",
  completeness: "unknown",
  diagnostics: { stdout: "", stderr: "", truncated: false },
});
