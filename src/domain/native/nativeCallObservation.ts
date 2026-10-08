import { z } from "zod";

const hexSchema = z.string().regex(/^0x[0-9a-f]+$/u);
/** Objective-C class names and selectors never contain spaces or brackets. */
const objcName = z
  .string()
  .min(1)
  .regex(/^[^\s[\]]+$/u, "Use the bare name without spaces or brackets");

const functionBreakpoint = {
  kind: z.literal("function"),
  name: z
    .string()
    .min(1)
    .describe(
      "Exact symbol name, such as `open`, a C++ or mangled Swift symbol, or `-[NSString length]`.",
    ),
};

const objcMethodBreakpoint = {
  kind: z.literal("objc-method"),
  selector: objcName.describe(
    "Selector such as `dataTaskWithRequest:completionHandler:`.",
  ),
};

/** One function or Objective-C method whose entries are observed. */
export const nativeCallBreakpointSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...functionBreakpoint,
    module: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Image file name that defines the symbol, such as `libsystem_kernel.dylib`; omit to match every image.",
      ),
  }),
  z.strictObject({
    ...objcMethodBreakpoint,
    class_name: objcName
      .optional()
      .describe("Implementing class; omit to match every class."),
    method_type: z.enum(["instance", "class", "any"]).default("any"),
  }),
]);

/**
 * Launch the active Mach-O as an owned process under LLDB and observe calls.
 * Duration and event bounds keep runtime observation finite.
 */
export const nativeCallObservationInputSchema = z.strictObject({
  breakpoints: z.array(nativeCallBreakpointSchema).min(1),
  arguments: z.array(z.string()).default([]),
  environment: z
    .record(
      z
        .string()
        .min(1)
        .regex(/^[^=\0]+$/u, "Environment names cannot contain '=' or NUL"),
      z.string().regex(/^[^\0]*$/u, "Environment values cannot contain NUL"),
    )
    .default({})
    .describe("Overrides on top of the environment REA runs with."),
  working_directory: z.string().min(1).optional(),
  duration_ms: z
    .number()
    .int()
    .min(100)
    .max(600_000)
    .default(10_000)
    .describe(
      "Observation window; the process is killed if it is still running.",
    ),
  max_events: z
    .number()
    .int()
    .min(1)
    .max(100_000)
    .default(1_000)
    .describe(
      "Stop observing and kill the process after this many recorded entries.",
    ),
  argument_registers: z
    .number()
    .int()
    .min(0)
    .max(8)
    .default(4)
    .describe(
      "Integer argument registers to record per entry (arm64 has 8, x86_64 has 6).",
    ),
  backtrace_frames: z
    .number()
    .int()
    .min(0)
    .max(64)
    .default(0)
    .describe("Caller frames to record per entry."),
});

export type NativeCallObservationInput = z.infer<
  typeof nativeCallObservationInputSchema
>;

/** A code address with the image and symbol LLDB attributes to it. */
export const nativeCodeLocationSchema = z.strictObject({
  load_address: hexSchema,
  file_address: hexSchema.nullable(),
  module: z.string().nullable(),
  module_path: z.string().nullable(),
  symbol: z.string().nullable(),
});

/** One observed entry into a requested function or method. */
export const nativeCallEventSchema = z.strictObject({
  sequence: z.number().int().nonnegative(),
  elapsed_ms: z.number().nonnegative(),
  thread_id: z.number().int().nonnegative(),
  breakpoint_index: z.number().int().nonnegative(),
  ...nativeCodeLocationSchema.shape,
  /** Dynamic class of an instance-method receiver, read without running code. */
  receiver_class: z.string().nullable(),
  /** Selector string read from the `_cmd` register of an Objective-C method. */
  selector: z.string().nullable(),
  registers: z.array(z.strictObject({ name: z.string(), value: hexSchema })),
  backtrace: z.array(nativeCodeLocationSchema),
});

const capturedOutputSchema = z.strictObject({
  text: z.string(),
  /** Bytes observed by the bridge, not a total when complete is false. */
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  complete: z.boolean(),
});

/** Observed calls, the process lifecycle, and breakpoint resolution. */
export const nativeCallObservationResultSchema = z.strictObject({
  target: z.strictObject({
    path: z.string(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    architecture: z.string(),
    arguments: z.array(z.string()),
    environment: z.record(z.string(), z.string()),
    working_directory: z.string().nullable(),
    launch_identity: z.strictObject({
      /** A pathname hash does not verify the bytes mapped into the process. */
      loaded_image_sha256: z.null(),
      file_device: z.string().nullable(),
      file_inode: z.string().nullable(),
      selected_file_sha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/u)
        .nullable(),
      module_path: z.string().nullable(),
      module_uuid: z.string().nullable(),
      stable: z.boolean(),
    }),
  }),
  debugger: z.strictObject({
    path: z.string(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    version: z.string().nullable(),
  }),
  process: z.strictObject({
    pid: z.number().int().positive(),
    outcome: z.enum([
      "exited",
      "duration-elapsed",
      "event-limit",
      "stop-limit",
      "resource-limit",
    ]),
    exit_status: z.number().int().nullable(),
    exit_description: z.string().nullable(),
    /** REA confirmed the process is gone when observation ended. */
    terminated: z.boolean(),
    elapsed_ms: z.number().nonnegative(),
    stdout: capturedOutputSchema,
    stderr: capturedOutputSchema,
    /** Signal and exception stops LLDB reported; the process continued past each. */
    other_stops: z.array(z.string()),
  }),
  breakpoints: z.array(
    z.strictObject({
      index: z.number().int().nonnegative(),
      request: z.discriminatedUnion("kind", [
        z.strictObject({
          ...functionBreakpoint,
          module: z.string().nullable(),
        }),
        z.strictObject({
          ...objcMethodBreakpoint,
          class_name: z.string().nullable(),
          method_type: z.enum(["instance", "class", "any"]),
        }),
      ]),
      location_count: z.number().int().nonnegative(),
      locations: z.array(nativeCodeLocationSchema),
    }),
  ),
  events: z.array(nativeCallEventSchema),
  coverage: z.strictObject({
    status: z.enum(["complete", "partial"]),
    event_limit_reached: z.boolean(),
    resource_limit_reached: z.boolean(),
    /** Requests that matched no code in any image loaded while observing. */
    unresolved_breakpoints: z.array(z.number().int().nonnegative()),
  }),
  limitations: z.array(z.string()),
});

export type NativeCallObservationResult = z.infer<
  typeof nativeCallObservationResultSchema
>;
