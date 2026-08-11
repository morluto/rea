import { z } from "zod";

/** Supported Windows package formats. */
export const packageFormatSchema = z.enum(["msix", "msi", "appx"]);
export type PackageFormat = z.infer<typeof packageFormatSchema>;

/** A resource entry within a package. */
export const packageResourceSchema = z.strictObject({
  /** Resource path within the package. */
  path: z.string().min(1),
  /** Resource type. */
  type: z.enum([
    "manifest",
    "icon",
    "configuration",
    "certificate",
    "executable",
    "library",
    "data",
    "other",
  ]),
  /** Size in bytes. */
  size: z.number().int().nonnegative(),
  /** SHA-256 digest. */
  digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
});
export type PackageResource = z.infer<typeof packageResourceSchema>;

/** Digital signature information. */
export const digitalSignatureSchema = z.strictObject({
  /** Whether the package is signed. */
  is_signed: z.boolean(),
  /** Signer subject name. */
  signer_subject: z.string().nullable(),
  /** Certificate thumbprint. */
  certificate_thumbprint: z.string().nullable(),
  /** Whether the signature is valid. */
  is_valid: z.boolean().default(false),
  /** Whether the signature is timestamped. */
  is_timestamped: z.boolean().default(false),
  /** Timestamp signer if present. */
  timestamp_signer: z.string().nullable(),
});

/** A Windows package manifest for static analysis. */
export const packageManifestSchema = z.strictObject({
  /** Package format. */
  format: packageFormatSchema,
  /** Package identity name. */
  name: z.string().min(1),
  /** Package publisher. */
  publisher: z.string().nullable(),
  /** Package version. */
  version: z.string().nullable(),
  /** Architecture. */
  architecture: z.enum(["x86", "x64", "arm", "arm64", "neutral", "unknown"]),
  /** Package resources. */
  resources: z.array(packageResourceSchema).default([]),
  /** Digital signature. */
  signature: digitalSignatureSchema,
  /** Whether the package is a framework. */
  is_framework: z.boolean().default(false),
  /** Package dependencies. */
  dependencies: z.array(z.string()).default([]),
  /** Capabilities declared in the manifest. */
  capabilities: z.array(z.string()).default([]),
});
export type PackageManifest = z.infer<typeof packageManifestSchema>;

/** Detect package format from file extension. */
export function detectPackageFormat(path: string): PackageFormat | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".msix")) return "msix";
  if (lower.endsWith(".msi")) return "msi";
  if (lower.endsWith(".appx")) return "appx";
  return null;
}

/** Check if a resource path looks like a manifest. */
export function isManifestResource(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.includes("appxmanifest.xml") ||
    lower.includes("appxmanifest") ||
    lower.includes("manifest.xml") ||
    lower.endsWith("_manifest.xml")
  );
}

/** Check if a resource path looks like a configuration file. */
export function isConfigurationResource(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.endsWith(".xml") ||
    lower.endsWith(".json") ||
    lower.endsWith(".ini") ||
    lower.endsWith(".config")
  );
}

/** Classify a resource by its path. */
export function classifyResource(path: string): PackageResource["type"] {
  if (isManifestResource(path)) return "manifest";
  const lower = path.toLowerCase();
  if (
    lower.endsWith(".ico") ||
    lower.endsWith(".png") ||
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg")
  )
    return "icon";
  if (isConfigurationResource(path)) return "configuration";
  if (
    lower.endsWith(".cer") ||
    lower.endsWith(".pfx") ||
    lower.endsWith(".p12")
  )
    return "certificate";
  if (lower.endsWith(".exe") || lower.endsWith(".dll"))
    return lower.endsWith(".exe") ? "executable" : "library";
  return "other";
}

/** Get all resources of a specific type. */
export function resourcesByType(
  manifest: PackageManifest,
  type: PackageResource["type"],
): PackageResource[] {
  return manifest.resources.filter((r) => r.type === type);
}

/** Get the total size of all resources. */
export function totalResourceSize(manifest: PackageManifest): number {
  return manifest.resources.reduce((sum, r) => sum + r.size, 0);
}

/** Check if a package has a valid signature. */
export function hasValidSignature(manifest: PackageManifest): boolean {
  return manifest.signature.is_signed && manifest.signature.is_valid;
}
