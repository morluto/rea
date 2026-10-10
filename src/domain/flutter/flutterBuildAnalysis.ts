import { z } from "zod";
import { localPathStringSchema } from "../localPath.js";
import { digestSchema } from "../digests.js";

/**
 * Caller intent for Flutter build identification. This family is pure
 * parsing: it reads an APK's `lib/<abi>/libapp.so` and `libflutter.so`
 * directly and runs no engine, tool, or device.
 */
export const flutterInputSchemas = {
  identify_flutter_build: z.strictObject({
    path: localPathStringSchema.describe("Local APK file to inspect"),
  }),
} as const;

/** Supported Flutter-backed operations. */
export type FlutterOperation = keyof typeof flutterInputSchemas;
/** Validated Flutter requests carry their selected operation. */
export type FlutterRequest = {
  [Name in FlutterOperation]: {
    operation: Name;
    input: z.infer<(typeof flutterInputSchemas)[Name]>;
  };
}[FlutterOperation];

/** Validate operation and input together so their types remain correlated. */
export const flutterRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("identify_flutter_build"),
    input: flutterInputSchemas.identify_flutter_build,
  }),
]);

/** One hardware ABI's Flutter payload inside the APK. */
export const flutterResultSchemas = {
  identify_flutter_build: z.strictObject({
    target: z.strictObject({
      path: localPathStringSchema,
      bytes: z.number().int().nonnegative(),
      sha256: digestSchema,
    }),
    flutter_detected: z.boolean(),
    abis: z.array(
      z.strictObject({
        abi: z.string().min(1),
        libapp: z.strictObject({
          present: z.boolean(),
          bytes: z.number().int().nonnegative().nullable(),
          sha256: digestSchema.nullable(),
          /** Number of Dart snapshot sections found (vm + isolate). */
          snapshot_hash_sources: z.number().int().nonnegative(),
          /** Distinct hashes found; more than one means the sections disagree. */
          snapshot_hash_candidates: z.array(
            z.string().regex(/^[0-9a-f]{32}$/u),
          ),
          /** The single hash when every snapshot section agrees. */
          snapshot_hash: z
            .string()
            .regex(/^[0-9a-f]{32}$/u)
            .nullable(),
        }),
        libflutter: z.strictObject({
          present: z.boolean(),
          bytes: z.number().int().nonnegative().nullable(),
          sha256: digestSchema.nullable(),
          build_id: z
            .string()
            .regex(/^[0-9a-f]{40}$/u)
            .nullable()
            .describe("GNU build-id note, when present"),
          dart_version: z
            .string()
            .nullable()
            .describe(
              "Labeled 'Dart VM version' string, when a build carries one",
            ),
          toolchain_lines: z.array(z.string().min(1)),
        }),
      }),
    ),
    coverage: z.enum(["complete", "partial"]),
  }),
} as const;
