import { z } from "zod";

import { applePlatformSchema, type ApplePlatform } from "./applePlatforms.js";
import { digestSchema } from "../digests.js";

/** Normalized path below the analyzed root: no `.`/`..` or empty segments. */
const ROOT_RELATIVE_PATH =
  /^(?!\/)(?!(?:.*\/)?\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\/$)[^\\\0]+$/u;
const rootRelativePathSchema = z.string().min(1).regex(ROOT_RELATIVE_PATH);

/** Caller selection of process roots and one CPU slice. */
export const dylibResolutionInputSchema = z.strictObject({
  roots: z.array(rootRelativePathSchema).min(1).optional(),
  architecture: z.enum(["arm64", "arm64e", "x86_64"]).optional(),
  /** Main dyld shared cache file whose image list answers system install paths. */
  shared_cache: z.string().min(1).optional(),
});

const dependencyCommandSchema = z.enum([
  "LC_LOAD_DYLIB",
  "LC_LOAD_WEAK_DYLIB",
  "LC_REEXPORT_DYLIB",
  "LC_LAZY_LOAD_DYLIB",
  "LC_LOAD_UPWARD_DYLIB",
]);

const dependencySchema = z.strictObject({
  command: dependencyCommandSchema,
  encoding: z.enum(["dylib_command", "dylib_use_command"]),
  install_name: z.string(),
  weak: z.boolean(),
  upward: z.boolean(),
  reexport: z.boolean(),
  delayed_init: z.boolean(),
  current_version: z.string(),
  compatibility_version: z.string(),
});

/** Observed dylib-loading facts of one Mach-O slice. */
export const machoSliceSchema = z.strictObject({
  architecture: z.string().min(1),
  file_type: z.enum(["execute", "dylib", "bundle", "other"]),
  install_name: z.string().nullable(),
  dependencies: z.array(dependencySchema),
  rpaths: z.array(z.string()),
  dyld_environment: z.array(z.string()),
  code_signature_present: z.boolean(),
  /** LC_BUILD_VERSION or LC_VERSION_MIN_* platforms; zippered images list two. */
  platforms: z.array(applePlatformSchema),
});

export type MachoDependency = z.infer<typeof dependencySchema>;
export type MachoSlice = z.infer<typeof machoSliceSchema>;

/** Header parse of one file; malformed and unsupported images keep their reason. */
export type MachoImageFacts =
  | { readonly status: "parsed"; readonly slices: readonly MachoSlice[] }
  | {
      readonly status: "malformed" | "unsupported";
      readonly reason: string;
    }
  | { readonly status: "not-mach-o" };

/** One observed path below the analyzed root. Symlink targets are not followed by the view. */
export type DylibTreeEntry =
  | { readonly kind: "file" | "directory" }
  | { readonly kind: "symlink"; readonly target: string };

/** Read-only, lazily probed view of the analyzed root. Paths are root-relative. */
export interface DylibTreeView {
  entry(path: string): Promise<DylibTreeEntry | undefined>;
  image(path: string): Promise<MachoImageFacts>;
}

/** Image list of one caller-supplied dyld shared cache. */
export interface DylibSharedCacheView {
  readonly architecture: string;
  /** The cache's platform and alternate platform; empty when the header predates them. */
  readonly platforms: readonly ApplePlatform[];
  /** Subcaches whose bytes are missing or do not match, such as `.03 (missing)`. */
  readonly unavailableSubcaches: readonly string[];
  /**
   * `mapped`: listed and inside an admitted mapping. That is address coverage,
   * not a load: a shared-cache hit also requires `image` to parse a slice this
   * process can load. `unverified`: listed, but the subcache holding it is
   * unavailable. `absent`: not listed.
   */
  lookup(path: string): "mapped" | "unverified" | "absent";
  /**
   * Load commands at a mapped install path. Undefined when `lookup` is not
   * `mapped`. Tracing uses this only to confirm the hit; cached load commands
   * are not traversed.
   */
  image(path: string): Promise<MachoImageFacts | undefined>;
}

const candidateSchema = z.strictObject({
  path: z.string(),
  source: z.enum([
    "literal",
    "executable_path",
    "loader_path",
    "rpath",
    "already-loaded",
  ]),
  rpath: z.string().nullable(),
  rpath_owner: z.string().nullable(),
  outcome: z.enum([
    "resolved",
    "absent",
    "not-mach-o",
    "malformed",
    "unsupported",
    "architecture-missing",
    "outside-target",
    "shared-cache",
    "escapes-target",
    "undetermined",
  ]),
  resolved_path: z.string().nullable(),
});

const edgeSchema = z.strictObject({
  root: z.string(),
  architecture: z.string(),
  loader: z.string(),
  via: z.array(z.string()),
  ...dependencySchema.shape,
  candidates: z.array(candidateSchema),
  resolution: z.strictObject({
    status: z.enum([
      "resolved",
      "conditional",
      "shared-cache",
      "unresolved",
      "undetermined",
    ]),
    image: z.string().nullable(),
  }),
  install_name_matches: z.boolean().nullable(),
  /**
   * The loader was reached through a conditional edge, so it might not load;
   * this edge describes what happens only if it does.
   */
  loader_conditional: z.boolean(),
});

const findingSchema = z.strictObject({
  kind: z.enum([
    "required-load-unresolved",
    "weak-load-unresolved",
    "lazy-load-unresolved",
    "earlier-rpath-candidate-absent",
    "dyld-environment-present",
  ]),
  edge_index: z.number().int().nonnegative().nullable(),
  image: z.string().nullable(),
  basis: z.literal("derived"),
  explanation: z.string().min(1),
});

const imageSchema = z.strictObject({
  path: z.string(),
  sha256: digestSchema,
  parse_status: z.enum(["parsed", "malformed", "unsupported"]),
  reason: z.string().nullable(),
  slices: z.array(machoSliceSchema.omit({ dependencies: true })),
});

/** Static dyld load-path resolution for every selected process root. */
export const dylibResolutionResultSchema = z.strictObject({
  root_path: z.string(),
  target_sha256: digestSchema,
  shared_cache: z
    .strictObject({
      path: z.string(),
      uuid: z.string(),
      architecture: z.string(),
      os_version: z.string().nullable(),
      main_file_sha256: digestSchema,
      subcache_sha256: z.record(z.string(), digestSchema).default({}),
    })
    .nullable(),
  roots: z.array(
    z.strictObject({ image: z.string(), architecture: z.string() }),
  ),
  images: z.array(imageSchema),
  edges: z.array(edgeSchema),
  findings: z.array(findingSchema),
  coverage: z.strictObject({
    status: z.enum(["complete", "partial"]),
    unparsed_images: z.array(z.string()),
    roots_without_architecture: z.array(z.string()),
    /** Install paths the supplied cache lists in subcaches that were unavailable. */
    unverified_shared_cache_images: z.array(z.string()),
  }),
  limitations: z.array(z.string().min(1)),
});

export type DylibResolutionResult = z.infer<typeof dylibResolutionResultSchema>;
export type DylibCandidate = z.infer<typeof candidateSchema>;
export type DylibEdge = z.infer<typeof edgeSchema>;
export type DylibFinding = z.infer<typeof findingSchema>;

/** Result before the adapter adds file digests and the analyzed root. */
export type DylibTrace = Omit<
  DylibResolutionResult,
  "root_path" | "target_sha256" | "shared_cache" | "images"
> & {
  readonly images: readonly (Omit<
    DylibResolutionResult["images"][number],
    "sha256"
  > & { readonly sha256?: never })[];
};
