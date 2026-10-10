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
  inspect_dart_aot: z.strictObject({
    path: localPathStringSchema.describe(
      "Local APK file carrying a Flutter AOT payload",
    ),
    abi: z
      .string()
      .min(2)
      .max(16)
      .regex(
        /^[a-z0-9_\x2d]+$/u,
        "ABI name as it appears under lib/, e.g. arm64-v8a",
      )
      .optional()
      .describe(
        "ABI to inspect; defaults to the first lib/<abi> that carries libapp.so",
      ),
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
  z.strictObject({
    operation: z.literal("inspect_dart_aot"),
    input: flutterInputSchemas.inspect_dart_aot,
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
  inspect_dart_aot: z.strictObject({
    target: z.strictObject({
      path: localPathStringSchema,
      bytes: z.number().int().nonnegative(),
      sha256: digestSchema,
    }),
    abi: z.string().min(1),
    libapp: z.strictObject({
      bytes: z.number().int().nonnegative(),
      sha256: digestSchema,
      snapshot_hash: z
        .string()
        .regex(/^[0-9a-f]{32}$/u)
        .nullable(),
      /** Snapshot symbols read from the dynamic symbol table. */
      sections: z.array(
        z.strictObject({
          name: z.string().min(1),
          offset: z.number().int().nonnegative(),
          size: z.number().int().nonnegative(),
          magic_valid: z.boolean(),
          kind: z.number().int().nonnegative().nullable(),
          header_length: z.number().int().nonnegative().nullable(),
        }),
      ),
    }),
    string_pool: z.strictObject({
      /** Distinct package: source URIs, sorted, bounded. */
      package_uris: z.array(z.string().min(1)),
      package_uri_count: z.number().int().nonnegative(),
      /** Distinct dart: SDK URIs, sorted, bounded. */
      dart_uris: z.array(z.string().min(1)),
      dart_uri_count: z.number().int().nonnegative(),
      /** Identifier-like tokens, bounded; includes incidental matches. */
      class_like_tokens: z.array(z.string().min(1)),
      class_like_token_count: z.number().int().nonnegative(),
      printable_run_count: z.number().int().nonnegative(),
    }),
    coverage: z.enum(["complete", "partial"]),
  }),
} as const;
