import { expect, it } from "vitest";
import {
  inspectRecordedCrashInputSchema,
  recordedCrashSchema,
} from "./recordedCrash.js";
import { recordedCrashFixture } from "../../../tests/fixtures/binaryDiagnostics/recordedCrash.js";

it("preserves high uint64 registers and historical thread identity", () => {
  const value = recordedCrashSchema.parse(recordedCrashFixture());
  expect(value.threads[0]?.registers[0]?.value).toBe("0x1122334455667788");
  expect(value.live_process_identity).toBe("unknown");
  expect(
    inspectRecordedCrashInputSchema.parse({ path: "/selected.core" })
      .include_debugger_context,
  ).toBe(false);
});

it.each([
  [
    "unsafe register number",
    (v: ReturnType<typeof recordedCrashFixture>) => ({
      ...v,
      threads: [
        {
          ...v.threads[0],
          registers: [
            {
              name: "rdi",
              value: 9007199254740992,
              location: { offset: "0x104", bytes: "0x8" },
            },
          ],
        },
      ],
    }),
  ],
  [
    "source outside artifact",
    (v: ReturnType<typeof recordedCrashFixture>) => ({
      ...v,
      artifact: { ...v.artifact, bytes: 120 },
    }),
  ],
  [
    "invalid note reference",
    (v: ReturnType<typeof recordedCrashFixture>) => ({
      ...v,
      threads: [{ ...v.threads[0], note_index: 1 }],
    }),
  ],
  [
    "register outside descriptor",
    (v: ReturnType<typeof recordedCrashFixture>) => ({
      ...v,
      threads: [
        {
          ...v.threads[0],
          registers: [
            {
              name: "rdi",
              value: "0x0",
              location: { offset: "0x1e4", bytes: "0x8" },
            },
          ],
        },
      ],
    }),
  ],
  [
    "raw descriptor length",
    (v: ReturnType<typeof recordedCrashFixture>) => ({
      ...v,
      notes: v.notes.map((n) => ({ ...n, descriptor_bytes_base64: "AA==" })),
    }),
  ],
  [
    "different owner ABI",
    (v: ReturnType<typeof recordedCrashFixture>) => ({
      ...v,
      notes: v.notes.map((n) => ({ ...n, owner_display: "OTHER" })),
    }),
  ],
  [
    "duplicate register",
    (v: ReturnType<typeof recordedCrashFixture>) => ({
      ...v,
      threads: v.threads.map((t) => ({
        ...t,
        registers: [...t.registers, ...t.registers],
      })),
    }),
  ],
] as const)("rejects %s before Evidence serialization", (_name, change) =>
  expect(
    recordedCrashSchema.safeParse(change(recordedCrashFixture())).success,
  ).toBe(false),
);

it("keeps absent map flags unknown and validates reported permission bits", () => {
  const value = recordedCrashFixture();
  const context = {
    status: "available",
    gdb_version: "fixture",
    pwndbg_version: "fixture",
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
        pathname_display: "recorded pathname",
        current_file_identity: "unknown",
      },
    ],
    confidence: "derived",
    completeness: "unknown",
    diagnostics: value.diagnostics,
  } as const;
  expect(
    recordedCrashSchema.safeParse({ ...value, debugger: context }).success,
  ).toBe(true);
  expect(
    recordedCrashSchema.safeParse({
      ...value,
      debugger: {
        ...context,
        maps: context.maps.map((m) => ({
          ...m,
          permissions: { read: false, write: false, execute: false },
        })),
      },
    }).success,
  ).toBe(false);
  expect(
    recordedCrashSchema.safeParse({
      ...value,
      debugger: {
        ...context,
        maps: context.maps.map((m) => ({
          ...m,
          reported_flags: 4,
          permissions: { read: false, write: false, execute: false },
        })),
      },
    }).success,
  ).toBe(false);
});
