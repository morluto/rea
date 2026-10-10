import { z } from "zod";
import { localPathStringSchema } from "../localPath.js";
import { digestSchema } from "../digests.js";

/** Upper bound for one decoded resource projection in one response. */
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_STRINGS = 2_000;

/**
 * Caller intent for Apktool-backed resource decoding. Apktool is
 * bring-your-own: REA never installs it, and decoding happens in a
 * provider-owned workspace that is removed after the facts are projected.
 */
export const apktoolInputSchemas = {
  inspect_apktool_client: z.strictObject({}),
  decode_android_resources: z.strictObject({
    path: localPathStringSchema.describe("Local APK file to decode"),
    include_strings: z
      .boolean()
      .default(true)
      .describe(
        `Project res/values/strings.xml entries (bounded to ${String(MAX_STRINGS)} entries)`,
      ),
    locale: z
      .string()
      .min(2)
      .max(16)
      .regex(
        /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/u,
        "Locale must look like de, pt-BR, or b+values variants' language part",
      )
      .optional()
      .describe(
        "Project strings from res/values-<locale>/strings.xml instead of the default table",
      ),
  }),
} as const;

/** Supported Apktool-backed operations. */
export type ApktoolOperation = keyof typeof apktoolInputSchemas;
/** Validated Apktool requests carry their selected operation. */
export type ApktoolRequest = {
  [Name in ApktoolOperation]: {
    operation: Name;
    input: z.infer<(typeof apktoolInputSchemas)[Name]>;
  };
}[ApktoolOperation];

/** Validate operation and input together so their types remain correlated. */
export const apktoolRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("inspect_apktool_client"),
    input: apktoolInputSchemas.inspect_apktool_client,
  }),
  z.strictObject({
    operation: z.literal("decode_android_resources"),
    input: apktoolInputSchemas.decode_android_resources,
  }),
]);

const client = z.strictObject({
  command: z.string().min(1),
  command_source: z.enum(["environment", "path"]),
  apktool_version: z.string().min(1).nullable(),
});

/** Portable Apktool observations with explicit coverage limitations. */
export const apktoolResultSchemas = {
  inspect_apktool_client: z.strictObject({
    client,
  }),
  decode_android_resources: z.strictObject({
    client,
    target: z.strictObject({
      path: localPathStringSchema,
      bytes: z.number().int().nonnegative(),
      sha256: digestSchema,
    }),
    metadata: z.strictObject({
      version_name: z.string().nullable(),
      version_code: z
        .string()
        .nullable()
        .describe(
          "Version code exactly as apktool.yml prints it, e.g. '45' or '45.1'",
        ),
      min_sdk_version: z.string().nullable(),
      target_sdk_version: z.string().nullable(),
      package_name: z.string().nullable(),
    }),
    manifest: z.string().nullable(),
    strings: z.array(
      z.strictObject({
        name: z.string().min(1),
        value: z.string(),
      }),
    ),
    locale: z.string().nullable(),
    locales: z.array(z.string().min(1)),
    decoded_file_count: z.number().int().nonnegative(),
    coverage: z.enum(["complete", "partial"]),
  }),
} as const;
