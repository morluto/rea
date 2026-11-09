import type { FileSnapshotPartialObservation } from "../fileSnapshotObservation.js";
import { z } from "zod";

import { digestSchema } from "../digests.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";

const uint = z.number().int().min(0).max(0xffffffff);
const recordedIntegerSchema = z.strictObject({
  decimal: z.string().regex(/^-?(?:0|[1-9][0-9]*)$/u),
  hex: z
    .string()
    .regex(/^0x[0-9a-f]+$/u)
    .nullable(),
});

/** Hard ceiling on the caller-selected input read budget. */
export const MAX_INSPECT_APPLE_IPS_FILE_BYTES = 16777216;
/** Hard ceiling on threads examined in one report. */
export const MAX_INSPECT_APPLE_IPS_THREADS = 4096;
/** Hard ceiling on frames across every thread. */
export const MAX_INSPECT_APPLE_IPS_FRAMES = 65536;
/** Hard ceiling on usedImages rows. */
export const MAX_INSPECT_APPLE_IPS_IMAGES = 4096;
/** Hard ceiling on the optional join Mach-O/dSYM read budget. */
export const MAX_INSPECT_APPLE_IPS_JOIN_BYTES = 256 * 1024 * 1024;
/** Hard ceiling on threadState register slots across every thread. */
export const MAX_INSPECT_APPLE_IPS_REGISTERS = 262144;
/** Conservative retained decimal/hex text capacity, measured as UTF-16 bytes. */
export const DEFAULT_INSPECT_APPLE_IPS_INTEGER_TEXT_BYTES = 8 * 1024 * 1024;
export const MAX_INSPECT_APPLE_IPS_INTEGER_TEXT_BYTES = 64 * 1024 * 1024;

export const APPLE_IPS_IMAGE_SOURCES = [
  "P",
  "S",
  "C",
  "K",
  "U",
  "T",
  "A",
] as const;
export type AppleIpsImageSource = (typeof APPLE_IPS_IMAGE_SOURCES)[number];

/** Documented meaning of usedImages source letters. */
export const APPLE_IPS_IMAGE_SOURCE_MEANING: Readonly<
  Record<AppleIpsImageSource, string>
> = {
  P: "process",
  S: "shared cache",
  C: "shared cache library",
  K: "kernel",
  U: "kernel cache",
  T: "kernel text exec",
  A: "absolute",
};

/** Complete bounded inspection of one Apple .ips crash report. */
export const inspectAppleIpsInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute filesystem path to an Apple .ips crash report",
  ),
  max_file_bytes: z
    .number()
    .int()
    .min(2)
    .max(MAX_INSPECT_APPLE_IPS_FILE_BYTES)
    .default(1048576)
    .describe("Maximum stable artifact bytes to read (default 1 MiB)"),
  max_threads: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_APPLE_IPS_THREADS)
    .default(256)
    .describe(
      "Maximum threads to examine; exceeding the budget fails without partial success",
    ),
  max_frames: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_APPLE_IPS_FRAMES)
    .default(8192)
    .describe(
      "Maximum frames across every thread; exceeding the budget fails without partial success",
    ),
  max_images: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_APPLE_IPS_IMAGES)
    .default(1024)
    .describe(
      "Maximum usedImages rows to examine; exceeding the budget fails without partial success",
    ),
  max_registers: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_APPLE_IPS_REGISTERS)
    .default(16384)
    .describe(
      "Maximum threadState register slots across every thread; exceeding the budget fails without partial success",
    ),
  max_integer_text_bytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_INSPECT_APPLE_IPS_INTEGER_TEXT_BYTES)
    .default(DEFAULT_INSPECT_APPLE_IPS_INTEGER_TEXT_BYTES)
    .describe(
      "Conservative UTF-16 byte allowance for all retained decimal/hex integer text, including derived addresses (default 8 MiB, maximum 64 MiB); checked before conversion and allocation",
    ),
  join_path: absoluteLocalPathStringSchema
    .optional()
    .describe(
      "Optional Mach-O executable or dSYM whose slice LC_UUID matches report images; unsigned images never join",
    ),
  max_join_bytes: z
    .number()
    .int()
    .min(2)
    .max(MAX_INSPECT_APPLE_IPS_JOIN_BYTES)
    .default(67108864)
    .describe(
      "Maximum stable artifact bytes read from join_path (default 64 MiB)",
    ),
});
export type InspectAppleIpsInput = z.infer<typeof inspectAppleIpsInputSchema>;

const uuidSchema = z
  .string()
  .regex(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/u);

// Observed IPS strings, including JSON member names, retain empty source text.
const metadataSchema = z.strictObject({
  bug_type: z.literal("309"),
  timestamp: z.string().nullable(),
  os_version: z.string().nullable(),
  bundle_id: z.string().nullable(),
  incident_id: z.string().nullable(),
  name: z.string().nullable(),
  build_version: z.string().nullable(),
  platform: recordedIntegerSchema.nullable(),
  unlisted_keys: z.array(z.string()),
});

const exceptionSchema = z
  .strictObject({
    type: z.string().nullable(),
    signal: z.string().nullable(),
    subtype: z.string().nullable(),
    codes: z.string().nullable(),
    message: z.string().nullable(),
    unlisted_keys: z.array(z.string()),
  })
  .nullable();

const terminationSchema = z
  .strictObject({
    namespace: z.string().nullable(),
    code: recordedIntegerSchema.nullable(),
    indicator: z.string().nullable(),
    flags: recordedIntegerSchema.nullable(),
    by_pid: recordedIntegerSchema.nullable(),
    by_proc: z.string().nullable(),
    reasons: z.array(z.string()).nullable(),
    unlisted_keys: z.array(z.string()),
  })
  .nullable();

const registerSchema = z.strictObject({
  name: z.string(),
  value: recordedIntegerSchema,
  description: z.string().nullable(),
});

const frameSchema = z.strictObject({
  thread_index: uint,
  frame_index: uint,
  image_index: uint
    .nullable()
    .describe(
      "Recorded index into images; image metadata and its uncertainty belong to that row.",
    ),
  image_offset: recordedIntegerSchema.nullable(),
  runtime_address: recordedIntegerSchema.nullable(),
  role: z.enum([
    "faulting_instruction",
    "current_instruction",
    "return_address",
    "unknown",
  ]),
  inline: z.boolean().nullable(),
  recorded_symbol: z.string().nullable(),
  symbol_location: recordedIntegerSchema
    .nullable()
    .describe(
      "Recorded byte offset of the address from the start of recorded_symbol.",
    ),
});

const threadSchema = z.strictObject({
  index: uint,
  id: recordedIntegerSchema.nullable(),
  triggered: z.boolean().nullable(),
  name: z.string().nullable(),
  queue: z.string().nullable(),
  frames: z.array(frameSchema),
  state_flavor: z.string().nullable(),
  registers: z.array(registerSchema),
});

const imageSchema = z.strictObject({
  index: uint,
  source: z.string().nullable(),
  source_meaning: z.string().min(1).nullable(),
  arch: z.string().nullable(),
  base: recordedIntegerSchema.nullable(),
  size: recordedIntegerSchema.nullable(),
  uuid: uuidSchema.nullable(),
  uuid_unknown: z.boolean(),
  name: z.string().nullable(),
  path: z.string().nullable(),
});

const classificationMatchSchema = z.strictObject({
  rule: z.enum([
    "watchdog",
    "dead10cc",
    "thermal",
    "guarded_file_descriptor",
    "guarded_mach_port",
    "possible_pointer_authentication_failure",
    "dyld_missing_library",
  ]),
  fields: z.array(
    z.strictObject({
      name: z.string().min(1),
      value: z.string().min(1),
    }),
  ),
});

const typeMismatchSchema = z.strictObject({
  path: z.string().min(1),
  expected: z.string().min(1),
  observed: z.string().min(1),
  recorded_value: z
    .string()
    .exactOptional()
    .describe(
      "Exact source spelling when a string fails its documented format",
    ),
  recorded_integer: z
    .string()
    .regex(/^-?(?:0|[1-9][0-9]*)$/u)
    .exactOptional()
    .describe(
      "Exact decimal literal of a rejected integer lookup; charged to the integer text allowance",
    ),
});

const coverageSchema = z.strictObject({
  status: z.enum(["complete", "partial"]),
  reason: z.string().min(1).nullable(),
  threads: uint,
  frames: uint,
  images: uint,
  registers: uint,
  type_mismatches: z.array(typeMismatchSchema),
});

const imageJoinMatchSchema = z.strictObject({
  image_index: uint,
  uuid: uuidSchema,
  recorded_arch: z.string().nullable(),
  slice_index: uint,
  slice_offset: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
  slice_arch: z.string().min(1),
  text_vmaddr: recordedIntegerSchema,
  runtime_base: recordedIntegerSchema.nullable(),
});

const frameJoinSchema = z.strictObject({
  thread_index: uint,
  frame_index: uint,
  status: z.enum(["joined", "unjoined"]),
  reason: z
    .string()
    .min(1)
    .nullable()
    .describe("Why the frame's image did not join the selected artifact."),
  static_address: recordedIntegerSchema
    .nullable()
    .describe("Slice __TEXT vmaddr plus the frame's recorded imageOffset."),
});

/** Slice identity resolution against one caller-selected Mach-O or dSYM. */
const joinSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("selected"),
    path: z.string().min(1),
    sha256: digestSchema,
    bytes: uint,
    slices: z.array(
      z.strictObject({
        index: uint,
        offset: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
        arch: z.string().min(1),
        cpu_type: z.string().min(1),
        cpu_subtype: z.string().min(1),
        uuid: uuidSchema.nullable(),
        text_vmaddr: recordedIntegerSchema.nullable(),
        unexamined: z.array(z.string().min(1)),
      }),
    ),
    image_matches: z.array(imageJoinMatchSchema),
    frames: z.array(frameJoinSchema),
    limitations: z.array(z.string().min(1)),
  }),
  z.strictObject({
    status: z.literal("unreadable"),
    path: z.string().min(1),
    sha256: digestSchema,
    bytes: uint,
    reason: z.string().min(1),
  }),
]);

const osVersionSchema = z
  .discriminatedUnion("form", [
    z.strictObject({ form: z.literal("text"), text: z.string() }),
    z.strictObject({
      form: z.literal("structured"),
      train: z.string().nullable(),
      build: z.string().nullable(),
      release_type: z.string().nullable(),
      is_embedded: z.boolean().nullable(),
      unlisted_keys: z.array(z.string()),
    }),
  ])
  .nullable();

/** Static Apple .ips crash-report inventory, read without execution. */
export const appleIpsSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256: digestSchema,
    bytes: uint,
  }),
  metadata: metadataSchema,
  process: z.strictObject({
    name: z.string().nullable(),
    path: z.string().nullable(),
    pid: recordedIntegerSchema.nullable(),
    parent: z.string().nullable(),
    parent_pid: recordedIntegerSchema.nullable(),
    cpu_type: z.string().nullable(),
    translated: z.boolean().nullable(),
    os_version: osVersionSchema,
  }),
  exception: exceptionSchema,
  termination: terminationSchema,
  faulting_thread: uint.nullable(),
  threads: z.array(threadSchema),
  images: z.array(imageSchema),
  classification: z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("classified"),
      matches: z.array(classificationMatchSchema).min(1),
    }),
    z.strictObject({
      status: z.literal("unclassified"),
      matches: z.array(classificationMatchSchema).max(0),
    }),
  ]),
  coverage: coverageSchema,
  unlisted_body_keys: z.array(z.string()),
  join: joinSchema.nullable(),
  limitations: z.array(z.string().min(1)),
});
export type AppleIps = z.infer<typeof appleIpsSchema>;
export type AppleIpsThread = z.infer<typeof threadSchema>;
export type AppleIpsImage = z.infer<typeof imageSchema>;
export type AppleIpsFrame = z.infer<typeof frameSchema>;
export type AppleIpsTypeMismatch = z.infer<typeof typeMismatchSchema>;
export type AppleIpsJoin = z.infer<typeof joinSchema>;
export type RecordedInteger = z.infer<typeof recordedIntegerSchema>;

/** Count each appearance, including repeated objects serialized at different paths. */
export const appleIpsIntegerTextBytes = (
  value: RecordedInteger | null,
): number =>
  value === null ? 0 : 2 * (value.decimal.length + (value.hex?.length ?? 0));

/** The named report fields own which observed and derived integers are retained. */
export const appleIpsReportIntegerTextBytes = (report: AppleIps): number => {
  let bytes =
    appleIpsIntegerTextBytes(report.metadata.platform) +
    appleIpsIntegerTextBytes(report.process.pid) +
    appleIpsIntegerTextBytes(report.process.parent_pid) +
    appleIpsIntegerTextBytes(report.termination?.code ?? null) +
    appleIpsIntegerTextBytes(report.termination?.flags ?? null) +
    appleIpsIntegerTextBytes(report.termination?.by_pid ?? null);
  for (const image of report.images)
    bytes +=
      appleIpsIntegerTextBytes(image.base) +
      appleIpsIntegerTextBytes(image.size);
  for (const thread of report.threads) {
    bytes += appleIpsIntegerTextBytes(thread.id);
    for (const register of thread.registers)
      bytes += appleIpsIntegerTextBytes(register.value);
    for (const frame of thread.frames)
      bytes +=
        appleIpsIntegerTextBytes(frame.image_offset) +
        appleIpsIntegerTextBytes(frame.runtime_address) +
        appleIpsIntegerTextBytes(frame.symbol_location);
  }
  for (const mismatch of report.coverage.type_mismatches)
    bytes += 2 * (mismatch.recorded_integer?.length ?? 0);
  if (report.join?.status === "selected") {
    for (const slice of report.join.slices)
      bytes +=
        2 *
          (slice.offset.length +
            slice.cpu_type.length +
            slice.cpu_subtype.length) +
        appleIpsIntegerTextBytes(slice.text_vmaddr);
    for (const match of report.join.image_matches)
      bytes +=
        2 * match.slice_offset.length +
        appleIpsIntegerTextBytes(match.text_vmaddr) +
        appleIpsIntegerTextBytes(match.runtime_base);
    for (const frame of report.join.frames)
      bytes += appleIpsIntegerTextBytes(frame.static_address);
  }
  return bytes;
};

/** Decoded report and independently completed join identity retained on failure. */
export type AppleIpsPartialObservation = AppleIps & {
  readonly join_artifact?: FileSnapshotPartialObservation;
};
