import { z } from "zod";

import { localPathStringSchema } from "../localPath.js";

const uint = z.number().int().min(0).max(0xffffffff);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

/** Hard ceiling on the caller-selected package read budget. */
export const MAX_BROWSER_EXTENSION_FILE_BYTES = 536870912;
/** Hard ceiling on uncompressed manifest.json bytes. */
export const MAX_BROWSER_EXTENSION_MANIFEST_BYTES = 8388608;
/** Hard ceiling on central-directory entries examined before reading the manifest. */
export const MAX_BROWSER_EXTENSION_ENTRIES = 100000;
/** Per-call budget bounds, shared by the input schema and limit recovery. */
export const BROWSER_EXTENSION_BUDGETS = Object.freeze({
  max_file_bytes: {
    minimum: 16,
    maximum: MAX_BROWSER_EXTENSION_FILE_BYTES,
    default_value: 67108864,
    unit: "bytes",
  },
  max_manifest_bytes: {
    minimum: 2,
    maximum: MAX_BROWSER_EXTENSION_MANIFEST_BYTES,
    default_value: 2097152,
    unit: "bytes",
  },
  max_entries: {
    minimum: 1,
    maximum: MAX_BROWSER_EXTENSION_ENTRIES,
    default_value: 20000,
    unit: "count",
  },
} as const);
/** Maximum distinct unresolved locale placeholders returned in one manifest. */
export const MAX_BROWSER_EXTENSION_MESSAGE_KEYS = 64;

/**
 * Read one local browser-extension package without loading it.
 * A directory is not an input: pass the package or its manifest.json.
 */
export const inspectBrowserExtensionInputSchema = z.strictObject({
  path: localPathStringSchema.describe(
    "Absolute path to a CRX, XPI, ZIP, or unpacked manifest.json",
  ),
  max_file_bytes: z
    .number()
    .int()
    .min(BROWSER_EXTENSION_BUDGETS.max_file_bytes.minimum)
    .max(BROWSER_EXTENSION_BUDGETS.max_file_bytes.maximum)
    .default(BROWSER_EXTENSION_BUDGETS.max_file_bytes.default_value)
    .describe("Maximum stable artifact bytes to read (default 64 MiB)"),
  max_manifest_bytes: z
    .number()
    .int()
    .min(BROWSER_EXTENSION_BUDGETS.max_manifest_bytes.minimum)
    .max(BROWSER_EXTENSION_BUDGETS.max_manifest_bytes.maximum)
    .default(BROWSER_EXTENSION_BUDGETS.max_manifest_bytes.default_value)
    .describe("Maximum uncompressed manifest.json bytes (default 2 MiB)"),
  max_entries: z
    .number()
    .int()
    .min(BROWSER_EXTENSION_BUDGETS.max_entries.minimum)
    .max(BROWSER_EXTENSION_BUDGETS.max_entries.maximum)
    .default(BROWSER_EXTENSION_BUDGETS.max_entries.default_value)
    .describe(
      "Maximum ZIP central-directory entries to examine before reading manifest.json",
    ),
});

export type InspectBrowserExtensionInput = z.infer<
  typeof inspectBrowserExtensionInputSchema
>;

const stringList = z.array(z.string().max(8192)).max(10000);

const contentScriptSchema = z.strictObject({
  matches: stringList,
  exclude_matches: stringList,
  js: stringList,
  css: stringList,
  run_at: z.string().max(64).nullable(),
  world: z.string().max(64).nullable(),
  all_frames: z.boolean().nullable(),
});

const backgroundSchema = z.strictObject({
  kind: z.enum(["service_worker", "scripts", "page", "unknown"]),
  service_worker: z.string().max(8192).nullable(),
  scripts: stringList,
  page: z.string().max(8192).nullable(),
  persistent: z.boolean().nullable(),
  type: z.string().max(64).nullable(),
});

const contentSecurityPolicySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("string"),
    value: z.string().max(65536),
  }),
  z.strictObject({
    kind: z.literal("object"),
    extension_pages: z.string().max(65536).nullable(),
    sandbox: z.string().max(65536).nullable(),
  }),
]);

const webAccessibleResourcesSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("paths"),
    resources: stringList,
  }),
  z.strictObject({
    kind: z.literal("entries"),
    entries: z
      .array(
        z.strictObject({
          resources: stringList,
          matches: stringList,
        }),
      )
      .max(1000),
  }),
]);

const geckoSchema = z.strictObject({
  id: z.string().max(512).nullable(),
  id_source: z.enum(["browser_specific_settings", "applications"]).nullable(),
  strict_min_version: z.string().max(64).nullable(),
  strict_max_version: z.string().max(64).nullable(),
  conflicting_id: z.string().max(512).nullable(),
});

/** Observed extension-manifest surface. Declared text is not runtime behavior. */
export const browserExtensionSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256,
    bytes: uint,
  }),
  format: z.enum(["crx2", "crx3", "zip", "unpacked"]),
  container: z
    .strictObject({
      zip_offset: uint,
      header_bytes: uint,
      crx_version: z.union([z.literal(2), z.literal(3)]).nullable(),
      public_key_bytes: uint.nullable(),
      signature_bytes: uint.nullable(),
    })
    .nullable(),
  manifest: z.strictObject({
    path: z.string().min(1),
    sha256,
    bytes: uint,
    manifest_version: z.union([z.literal(2), z.literal(3), z.literal("other")]),
    name: z.string().max(8192).nullable(),
    version: z.string().max(128).nullable(),
    description: z.string().max(8192).nullable(),
    default_locale: z.string().max(64).nullable(),
    message_keys: z
      .array(z.string().max(256))
      .max(MAX_BROWSER_EXTENSION_MESSAGE_KEYS),
    permissions: stringList,
    optional_permissions: stringList,
    host_permissions: stringList,
    optional_host_permissions: stringList,
    content_scripts: z.array(contentScriptSchema).max(1000),
    background: backgroundSchema.nullable(),
    gecko: geckoSchema.nullable(),
    action_keys: z.array(z.enum(["action", "browser_action", "page_action"])),
    content_security_policy: contentSecurityPolicySchema.nullable(),
    incognito: z.string().max(64).nullable(),
    side_panel: z.boolean(),
    commands: stringList,
    web_accessible_resources: webAccessibleResourcesSchema.nullable(),
    externally_connectable_matches: stringList,
    unknown_keys: stringList,
  }),
  limitations: z.array(z.string().min(1)).min(1),
});

export type BrowserExtensionReport = z.infer<typeof browserExtensionSchema>;
