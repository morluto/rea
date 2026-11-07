import { z } from "zod";
import { digestSchema } from "../digests.js";
import { androidManifestLocationSchema } from "./androidManifestComponents.js";

export const ANDROID_APP_FUNCTION_SERVICE_ACTION =
  "android.app.appfunctions.AppFunctionService";
export const ANDROID_BIND_APP_FUNCTION_PERMISSION =
  "android.permission.BIND_APP_FUNCTION_SERVICE";

export const androidAppFunctionSchemaPointerSchema = z.strictObject({
  source: z.enum(["property", "meta-data"]),
  name: z.string(),
  value: z.string().nullable(),
  resource: z.string().nullable(),
  resolved_asset_path: z.string().nullable(),
  location: androidManifestLocationSchema.nullable(),
});
export type AndroidAppFunctionSchemaPointer = Readonly<
  z.output<typeof androidAppFunctionSchemaPointerSchema>
>;

export const androidAppFunctionServiceSchema = z.strictObject({
  declared_name: z.string(),
  name: z.string(),
  declaration_index: z.int().nonnegative(),
  location: androidManifestLocationSchema.nullable(),
  exported: z.boolean().nullable(),
  permission: z.string().nullable(),
  binds_system_permission: z.boolean(),
  declares_service_action: z.boolean(),
  schema_pointers: z.array(androidAppFunctionSchemaPointerSchema),
});
export type AndroidAppFunctionService = Readonly<
  z.output<typeof androidAppFunctionServiceSchema>
>;

export const androidAppFunctionEntrySchema = z.strictObject({
  id: z.string().nullable(),
  schema_name: z.string().nullable(),
  schema_category: z.string().nullable(),
  schema_version: z.string().nullable(),
  enabled_by_default: z.boolean().nullable(),
});
export type AndroidAppFunctionEntry = Readonly<
  z.output<typeof androidAppFunctionEntrySchema>
>;

export const androidAppFunctionSchemaAssetSchema = z.strictObject({
  path: z.string().min(1),
  source_path: z.string().min(1),
  sha256: digestSchema.nullable(),
  size: z.int().nonnegative().nullable(),
  status: z.enum(["complete", "partial", "unavailable"]),
  functions: z.array(androidAppFunctionEntrySchema),
  limitations: z.array(z.string()),
});
export type AndroidAppFunctionSchemaAsset = Readonly<
  z.output<typeof androidAppFunctionSchemaAssetSchema>
>;

/** Static AppFunctions manifest bindings and bundled XML schema inventory. */
export const androidAppFunctionsSchema = z.strictObject({
  status: z.enum(["complete", "partial", "unavailable"]),
  services: z.array(androidAppFunctionServiceSchema),
  schemas: z.array(androidAppFunctionSchemaAssetSchema),
  limitations: z.array(z.string()),
});
export type AndroidAppFunctionsInventory = Readonly<
  z.output<typeof androidAppFunctionsSchema>
>;

/** Parsed, JSON-only checkpoint captured before a live APK ZIP reader is finalized. */
export const androidAppFunctionAssetCheckpointSchema = z.strictObject({
  scan_state: z.enum(["completed", "interrupted"]),
  status: z.enum(["complete", "partial", "unavailable"]),
  examined_entries: z.int().nonnegative(),
  schemas: z.array(androidAppFunctionSchemaAssetSchema),
  limitations: z.array(z.string()),
});
export type AndroidAppFunctionAssetCheckpoint = Readonly<
  z.output<typeof androidAppFunctionAssetCheckpointSchema>
>;

export const androidAppFunctionsPartialFactsSchema = z.strictObject({
  manifest_status: z.enum(["complete", "partial", "unavailable"]).nullable(),
  services: z.array(androidAppFunctionServiceSchema),
  referenced_asset_paths: z.array(z.string()),
  manifest_limitations: z.array(z.string()),
  assets: androidAppFunctionAssetCheckpointSchema.nullable(),
});

export const androidAppFunctionsSummarySchema = z.strictObject({
  service_count: z.int().nonnegative(),
  system_bound_service_count: z.int().nonnegative(),
  schema_count: z.int().nonnegative(),
  function_count: z.int().nonnegative(),
});
export type AndroidAppFunctionsSummary = Readonly<
  z.output<typeof androidAppFunctionsSummarySchema>
>;

export const summarizeAndroidAppFunctions = (
  inventory: AndroidAppFunctionsInventory,
): AndroidAppFunctionsSummary => ({
  service_count: inventory.services.length,
  system_bound_service_count: inventory.services.filter(
    (service) => service.binds_system_permission,
  ).length,
  schema_count: inventory.schemas.length,
  function_count: inventory.schemas.reduce(
    (sum, schema) => sum + schema.functions.length,
    0,
  ),
});
