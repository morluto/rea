import { z } from "zod";

/** Supported mobile artifact formats. */
export const mobileArtifactFormatSchema = z.enum([
  "apk",
  "aab",
  "ipa",
  "dex",
  "native_lib",
]);
export type MobileArtifactFormat = z.infer<typeof mobileArtifactFormatSchema>;

/** Mobile platform. */
export const mobilePlatformSchema = z.enum([
  "android",
  "ios",
  "cross_platform",
]);
export type MobilePlatform = z.infer<typeof mobilePlatformSchema>;

/** Android manifest entry. */
export const androidManifestSchema = z.strictObject({
  package_name: z.string().min(1),
  version_name: z.string().nullable(),
  version_code: z.number().int().nullable(),
  min_sdk: z.number().int().nullable(),
  target_sdk: z.number().int().nullable(),
  permissions: z.array(z.string()).default([]),
  activities: z.array(z.string()).default([]),
  services: z.array(z.string()).default([]),
  receivers: z.array(z.string()).default([]),
  providers: z.array(z.string()).default([]),
});
export type AndroidManifest = z.infer<typeof androidManifestSchema>;

/** iOS app manifest (Info.plist). */
export const iosManifestSchema = z.strictObject({
  bundle_identifier: z.string().min(1),
  bundle_version: z.string().nullable(),
  short_version: z.string().nullable(),
  minimum_os_version: z.string().nullable(),
  supported_platforms: z.array(z.string()).default([]),
  ui_required_device_capabilities: z.array(z.string()).default([]),
  app_permissions: z.array(z.string()).default([]),
});
/** Signing information. */
export const signingInfoSchema = z.strictObject({
  is_signed: z.boolean().default(false),
  signer_identity: z.string().nullable(),
  certificate_fingerprint: z.string().nullable(),
  signature_scheme: z.string().nullable(),
  is_debuggable: z.boolean().default(false),
});
export type SigningInfo = z.infer<typeof signingInfoSchema>;

/** Native library entry. */
export const nativeLibrarySchema = z.strictObject({
  path: z.string().min(1),
  architecture: z.string().nullable(),
  size: z.number().int().nonnegative(),
  digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
});
export type NativeLibrary = z.infer<typeof nativeLibrarySchema>;

/** Resource entry within a mobile artifact. */
export const mobileResourceSchema = z.strictObject({
  path: z.string().min(1),
  type: z.enum([
    "layout",
    "drawable",
    "string",
    "asset",
    "raw",
    "native_lib",
    "manifest",
    "entitlements",
    "provisioning",
    "other",
  ]),
  size: z.number().int().nonnegative(),
});
export type MobileResource = z.infer<typeof mobileResourceSchema>;

/** Static analysis result for a mobile artifact. */
export const mobileArtifactManifestSchema = z.strictObject({
  format: mobileArtifactFormatSchema,
  platform: mobilePlatformSchema,
  app_name: z.string().nullable(),
  android_manifest: androidManifestSchema.nullable(),
  ios_manifest: iosManifestSchema.nullable(),
  signing: signingInfoSchema,
  resources: z.array(mobileResourceSchema).default([]),
  native_libraries: z.array(nativeLibrarySchema).default([]),
  total_size: z.number().int().nonnegative(),
  architectures: z.array(z.string()).default([]),
});
export type MobileArtifactManifest = z.infer<
  typeof mobileArtifactManifestSchema
>;

/** Detect mobile artifact format from file extension. */
export function detectMobileFormat(path: string): MobileArtifactFormat | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".apk")) return "apk";
  if (lower.endsWith(".aab")) return "aab";
  if (lower.endsWith(".ipa")) return "ipa";
  if (lower.endsWith(".dex")) return "dex";
  if (lower.endsWith(".so") || lower.endsWith(".dylib") || lower.endsWith(".a"))
    return "native_lib";
  return null;
}

/** Detect platform from format. */
export function detectPlatform(format: MobileArtifactFormat): MobilePlatform {
  switch (format) {
    case "apk":
    case "aab":
    case "dex":
      return "android";
    case "ipa":
      return "ios";
    case "native_lib":
      return "cross_platform";
  }
}

/** Classify a resource by its path. */
export function classifyMobileResource(path: string): MobileResource["type"] {
  const lower = path.toLowerCase();
  if (lower.includes("androidmanifest.xml")) return "manifest";
  if (lower.includes(".entitlements")) return "entitlements";
  if (lower.includes("provisioning") || lower.includes(".mobileprovision"))
    return "provisioning";
  if (lower.includes("/layout/")) return "layout";
  if (lower.includes("/drawable/") || lower.includes("/mipmap/"))
    return "drawable";
  if (lower.includes("/values/")) return "string";
  if (lower.includes("assets/") || lower.includes("raw/")) return "asset";
  if (lower.endsWith(".so") || lower.endsWith(".dylib")) return "native_lib";
  if (lower.endsWith(".xml")) return "layout";
  return "other";
}

/** Get all native libraries for a specific architecture. */
export function nativeLibsByArchitecture(
  manifest: MobileArtifactManifest,
  arch: string,
): NativeLibrary[] {
  return manifest.native_libraries.filter((l) => l.architecture === arch);
}

/** Check if an Android artifact has internet permission. */
export function hasInternetPermission(
  manifest: MobileArtifactManifest,
): boolean {
  if (!manifest.android_manifest) return false;
  return manifest.android_manifest.permissions.some(
    (p) => p.includes("INTERNET") || p.includes("android.permission.INTERNET"),
  );
}

/** Get all unique architectures across native libraries. */
export function getAllArchitectures(
  manifest: MobileArtifactManifest,
): string[] {
  const archs = new Set<string>();
  for (const lib of manifest.native_libraries) {
    if (lib.architecture) archs.add(lib.architecture);
  }
  for (const arch of manifest.architectures) {
    archs.add(arch);
  }
  return [...archs];
}
