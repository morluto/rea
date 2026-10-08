import { z } from "zod";

import {
  compatibleSlice,
  directoryOf,
  expandPrefix,
  joinPath,
  resolveTreePath,
  type Expansion,
} from "./dyldPaths.js";
import { digestSchema } from "../digests.js";
import {
  DYLIB_RESOLUTION_LIMITATIONS,
  deriveFindings,
} from "./dylibResolutionFindings.js";

/** Normalized path below the analyzed root: no `.`/`..` or empty segments. */
const ROOT_RELATIVE_PATH =
  /^(?!\/)(?!(?:.*\/)?\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\/$)[^\\\0]+$/u;
const rootRelativePathSchema = z.string().min(1).regex(ROOT_RELATIVE_PATH);

/** Caller selection of process roots and one CPU slice. */
export const dylibResolutionInputSchema = z.strictObject({
  roots: z.array(rootRelativePathSchema).min(1).optional(),
  architecture: z.enum(["arm64", "arm64e", "x86_64"]).optional(),
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
  /** Physical identity observed in the thin header and, for FAT, its table. */
  slice_offset: z.number().int().nonnegative(),
  slice_size: z.number().int().positive(),
  cpu_type: z.number().int().nonnegative(),
  cpu_subtype: z.number().int().nonnegative(),
  fat_cpu_type: z.number().int().nonnegative().nullable(),
  fat_cpu_subtype: z.number().int().nonnegative().nullable(),
  fat_alignment_exponent: z.number().int().nonnegative().nullable(),
  file_type: z.enum(["execute", "dylib", "bundle", "other"]),
  file_type_code: z.number().int().nonnegative(),
  /** Raw LC_BUILD_VERSION platform number; null means no such command was observed. */
  platform: z.number().int().nonnegative().nullable(),
  /** Every distinct build platform declared by LC_BUILD_VERSION/version-min commands. */
  platforms: z.array(z.number().int().nonnegative()),
  install_name: z.string().nullable(),
  dependencies: z.array(dependencySchema),
  rpaths: z.array(z.string()),
  dyld_environment: z.array(z.string()),
  code_signature_present: z.boolean(),
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
    "not-loadable",
    "platform-mismatch",
    "outside-target",
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
    status: z.enum(["resolved", "conditional", "unresolved", "undetermined"]),
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
  }),
  limitations: z.array(z.string().min(1)),
});

export type DylibResolutionResult = z.infer<typeof dylibResolutionResultSchema>;
type Candidate = z.infer<typeof candidateSchema>;
export type DylibEdge = z.infer<typeof edgeSchema>;
export type DylibFinding = z.infer<typeof findingSchema>;
type Edge = DylibEdge;

/** Result before the adapter adds file digests and the analyzed root. */
export type DylibTrace = Omit<
  DylibResolutionResult,
  "root_path" | "target_sha256" | "images"
> & {
  readonly images: readonly (Omit<
    DylibResolutionResult["images"][number],
    "sha256"
  > & { readonly sha256?: never })[];
};

interface LoadedImage {
  readonly slice: MachoSlice;
  /** Images from the process root to this image; the rpath stack, outermost first. */
  readonly chain: readonly string[];
  /** Some edge on the chain was conditional: an unknown earlier candidate may load instead. */
  readonly conditional: boolean;
}

interface ProcessContext {
  readonly view: DylibTreeView;
  readonly root: string;
  readonly architecture: string;
  readonly platforms: readonly number[];
  readonly executable: string | null;
  readonly loaded: Map<string, LoadedImage>;
  readonly byInstallName: Map<string, string>;
  readonly images: Map<string, MachoImageFacts>;
}

interface CandidateTemplate {
  readonly expansion: Expansion;
  readonly source: Candidate["source"];
  readonly rpath: string | null;
  readonly rpathOwner: string | null;
}

const candidateTemplates = (
  dependency: MachoDependency,
  loader: string,
  context: ProcessContext,
): CandidateTemplate[] => {
  const name = dependency.install_name;
  if (!name.startsWith("@rpath/")) {
    const source = name.startsWith("@executable_path")
      ? "executable_path"
      : name.startsWith("@loader_path")
        ? "loader_path"
        : "literal";
    return [
      {
        expansion: expandPrefix(name, {
          ownerDirectory: directoryOf(loader),
          executable: context.executable,
        }),
        source,
        rpath: null,
        rpathOwner: null,
      },
    ];
  }
  const rest = name.slice("@rpath/".length);
  const owners = [...(context.loaded.get(loader)?.chain ?? [loader])].reverse();
  return owners.flatMap((owner) =>
    (context.loaded.get(owner)?.slice.rpaths ?? []).map((rpath) => {
      const base = expandPrefix(rpath, {
        ownerDirectory: directoryOf(owner),
        executable: context.executable,
      });
      const expansion: Expansion = {
        scope: base.scope,
        path:
          base.scope === "outside"
            ? `${base.path.replace(/\/+$/u, "")}/${rest}`
            : joinPath(base.path, rest),
      };
      return { expansion, source: "rpath" as const, rpath, rpathOwner: owner };
    }),
  );
};

const evaluateCandidate = async (
  template: CandidateTemplate,
  context: ProcessContext,
): Promise<Candidate> => {
  const base = {
    path: template.expansion.path,
    source: template.source,
    rpath: template.rpath,
    rpath_owner: template.rpathOwner,
  };
  if (template.expansion.scope === "outside")
    return { ...base, outcome: "outside-target", resolved_path: null };
  if (template.expansion.scope === "undetermined")
    return { ...base, outcome: "undetermined", resolved_path: null };
  const lookup = await resolveTreePath(context.view, template.expansion.path);
  if (lookup.kind === "escapes")
    return { ...base, outcome: "escapes-target", resolved_path: null };
  if (lookup.kind !== "file")
    return { ...base, outcome: "absent", resolved_path: null };
  const facts = await imageFacts(context, lookup.path);
  let outcome: Candidate["outcome"];
  if (facts.status !== "parsed") outcome = facts.status;
  else {
    const slice = compatibleSlice(facts.slices, context.architecture);
    if (slice === undefined) outcome = "architecture-missing";
    else if (![2, 6, 7, 8].includes(slice.file_type_code))
      outcome = "not-loadable";
    else {
      const platformResult = platformLoadability(
        context.platforms,
        slice.platforms,
        slice.file_type_code,
        context.architecture,
      );
      outcome =
        platformResult === "compatible"
          ? "resolved"
          : platformResult === "incompatible"
            ? "platform-mismatch"
            : "undetermined";
    }
  }
  return { ...base, outcome, resolved_path: lookup.path };
};

type PlatformLoadability = "compatible" | "incompatible" | "unknown";

/** Apply dyld's documented cross-platform load cases and retain uncertain host cases. */
const platformLoadability = (
  processPlatforms: readonly number[],
  imagePlatforms: readonly number[],
  fileType: number,
  architecture: string,
): PlatformLoadability => {
  if (processPlatforms.length === 0 || imagePlatforms.length === 0)
    return "unknown";
  const outcomes = processPlatforms.map((processPlatform) =>
    imageLoadabilityForPlatform(
      processPlatform,
      imagePlatforms,
      fileType,
      architecture,
    ),
  );
  if (outcomes.every((outcome) => outcome === "compatible"))
    return "compatible";
  if (outcomes.every((outcome) => outcome === "incompatible"))
    return "incompatible";
  return "unknown";
};

const imageLoadabilityForPlatform = (
  processPlatform: number,
  imagePlatforms: readonly number[],
  fileType: number,
  architecture: string,
): PlatformLoadability => {
  if (imagePlatforms.includes(processPlatform)) return "compatible";

  // These are explicit dyld loadableIntoProcess cross-platform cases.
  if (processPlatform === 6 && imagePlatforms.includes(1)) return "compatible"; // macOS dylibs in Mac Catalyst processes
  if (processPlatform === 2 && imagePlatforms.includes(6)) return "compatible"; // Catalyst dylibs in iOS processes
  if (processPlatform === 2 && imagePlatforms.includes(11)) return "compatible"; // visionOS dylibs in iOS processes
  if (processPlatform === 7 && imagePlatforms.includes(12)) return "compatible"; // visionOS simulator dylibs in iOS simulator processes
  if (processPlatform === 1 && fileType === 2 && imagePlatforms.includes(6))
    return "compatible"; // Catalyst main executables run on macOS

  // dyld's remaining exceptions depend on host architecture or a special path.
  if (
    (processPlatform === 2 &&
      imagePlatforms.includes(1) &&
      architecture.startsWith("arm64")) ||
    ([7, 8, 9].includes(processPlatform) && imagePlatforms.includes(1))
  )
    return "unknown";

  if (isKnownPlatform(processPlatform) && imagePlatforms.every(isKnownPlatform))
    return "incompatible";
  return "unknown";
};

const isKnownPlatform = (platform: number): boolean =>
  platform >= 1 && platform <= 12;

const imageFacts = async (
  context: ProcessContext,
  path: string,
): Promise<MachoImageFacts> => {
  const known = context.images.get(path);
  if (known !== undefined) return known;
  const facts = await context.view.image(path);
  context.images.set(path, facts);
  return facts;
};

const resolution = (candidates: readonly Candidate[]): Edge["resolution"] => {
  let external = false;
  for (const candidate of candidates) {
    if (candidate.outcome === "resolved")
      return {
        status: external ? "conditional" : "resolved",
        image: candidate.resolved_path,
      };
    // dyld might load these; REA cannot decide them from the analyzed root.
    if (
      candidate.outcome === "outside-target" ||
      candidate.outcome === "escapes-target" ||
      candidate.outcome === "unsupported" ||
      candidate.outcome === "undetermined"
    )
      external = true;
  }
  return { status: external ? "undetermined" : "unresolved", image: null };
};

const resolveDependency = async (
  dependency: MachoDependency,
  loader: string,
  context: ProcessContext,
): Promise<Edge> => {
  const current = context.loaded.get(loader);
  const chain = current?.chain ?? [loader];
  const loaded = context.byInstallName.get(dependency.install_name);
  const candidates: Candidate[] = [];
  if (loaded !== undefined)
    candidates.push({
      path: dependency.install_name,
      source: "already-loaded",
      rpath: null,
      rpath_owner: null,
      outcome: "resolved",
      resolved_path: loaded,
    });
  else
    for (const template of candidateTemplates(dependency, loader, context)) {
      const candidate = await evaluateCandidate(template, context);
      candidates.push(candidate);
      // dyld stops at the first loadable candidate.
      if (candidate.outcome === "resolved") break;
    }
  const searched = resolution(candidates);
  // Reusing an image that itself loads only conditionally is conditional too.
  const resolved: Edge["resolution"] =
    loaded !== undefined &&
    context.loaded.get(loaded)?.conditional === true &&
    searched.status === "resolved"
      ? { ...searched, status: "conditional" }
      : searched;
  const image =
    resolved.image === null ? undefined : context.images.get(resolved.image);
  const slice =
    image?.status === "parsed"
      ? compatibleSlice(image.slices, context.architecture)
      : undefined;
  return {
    root: context.root,
    architecture: context.architecture,
    loader,
    via: [...chain],
    ...dependency,
    candidates,
    resolution: resolved,
    install_name_matches:
      slice === undefined || slice.install_name === null
        ? null
        : slice.install_name === dependency.install_name,
    loader_conditional: current?.conditional ?? false,
  };
};

/**
 * Follow dyld4's dependents-first order: resolve every dependency of one
 * image, then recurse into the images it newly loaded, in load-command order.
 */
const traceProcess = async (
  context: ProcessContext,
  rootSlice: MachoSlice,
  signal?: AbortSignal,
): Promise<Edge[]> => {
  const edges: Edge[] = [];
  context.loaded.set(context.root, {
    slice: rootSlice,
    chain: [context.root],
    conditional: false,
  });
  if (rootSlice.install_name !== null)
    context.byInstallName.set(rootSlice.install_name, context.root);
  const pending = [context.root];
  while (pending.length > 0) {
    signal?.throwIfAborted();
    const loader = pending.pop() ?? "";
    const current = context.loaded.get(loader);
    if (current === undefined) continue;
    const created: string[] = [];
    for (const dependency of current.slice.dependencies) {
      const edge = await resolveDependency(dependency, loader, context);
      edges.push(edge);
      // dyld loads LC_LAZY_LOAD_DYLIB images on first use, not at launch.
      if (dependency.command === "LC_LAZY_LOAD_DYLIB") continue;
      const image = edge.resolution.image;
      if (image === null || context.loaded.has(image)) continue;
      const facts = context.images.get(image);
      const slice =
        facts?.status === "parsed"
          ? compatibleSlice(facts.slices, context.architecture)
          : undefined;
      if (slice === undefined) continue;
      context.loaded.set(image, {
        slice,
        chain: [...current.chain, image],
        // dyld may load an unknown earlier candidate instead of this fallback.
        conditional:
          current.conditional || edge.resolution.status === "conditional",
      });
      if (
        slice.install_name !== null &&
        !context.byInstallName.has(slice.install_name)
      )
        context.byInstallName.set(slice.install_name, image);
      created.push(image);
    }
    pending.push(...created.reverse());
  }
  return edges;
};

/** Trace dyld load paths from each process root through the analyzed root. */
export const traceDylibLoading = async (
  view: DylibTreeView,
  request: {
    readonly roots: readonly string[];
    /** Mach-O files whose root role could not be classified because they did not parse. */
    readonly unclassified?: readonly string[];
    readonly architecture?: string;
    readonly signal?: AbortSignal;
  },
): Promise<DylibTrace> => {
  const images = new Map<string, MachoImageFacts>();
  for (const path of request.unclassified ?? [])
    images.set(path, await view.image(path));
  const roots: DylibTrace["roots"][number][] = [];
  const edges: Edge[] = [];
  const withoutArchitecture: string[] = [];
  for (const root of request.roots) {
    const facts = await view.image(root);
    images.set(root, facts);
    if (facts.status !== "parsed") continue;
    const slices = facts.slices.filter(
      ({ architecture }) =>
        request.architecture === undefined ||
        architecture === request.architecture,
    );
    if (slices.length === 0) withoutArchitecture.push(root);
    for (const slice of slices) {
      roots.push({ image: root, architecture: slice.architecture });
      edges.push(
        ...(await traceProcess(
          {
            view,
            root,
            architecture: slice.architecture,
            platforms: slice.platforms,
            executable: slice.file_type === "execute" ? root : null,
            loaded: new Map(),
            byInstallName: new Map(),
            images,
          },
          slice,
          request.signal,
        )),
      );
    }
  }
  const reported = [...images.entries()]
    .filter(([, facts]) => facts.status !== "not-mach-o")
    .sort(([left], [right]) => compare(left, right));
  const unparsed = reported
    .filter(([, facts]) => facts.status !== "parsed")
    .map(([path]) => path);
  return {
    roots,
    images: reported.map(([path, facts]) => ({
      path,
      parse_status:
        facts.status === "not-mach-o" ? "unsupported" : facts.status,
      reason:
        facts.status === "parsed" || facts.status === "not-mach-o"
          ? null
          : facts.reason,
      slices:
        facts.status === "parsed" ? facts.slices.map(withoutDependencies) : [],
    })),
    edges,
    findings: deriveFindings(edges, roots, images),
    coverage: {
      status:
        unparsed.length === 0 && withoutArchitecture.length === 0
          ? "complete"
          : "partial",
      unparsed_images: unparsed,
      roots_without_architecture: withoutArchitecture,
    },
    limitations: DYLIB_RESOLUTION_LIMITATIONS,
  };
};

const withoutDependencies = (
  slice: MachoSlice,
): Omit<MachoSlice, "dependencies"> => ({
  architecture: slice.architecture,
  slice_offset: slice.slice_offset,
  slice_size: slice.slice_size,
  cpu_type: slice.cpu_type,
  cpu_subtype: slice.cpu_subtype,
  fat_cpu_type: slice.fat_cpu_type,
  fat_cpu_subtype: slice.fat_cpu_subtype,
  fat_alignment_exponent: slice.fat_alignment_exponent,
  file_type: slice.file_type,
  file_type_code: slice.file_type_code,
  platform: slice.platform,
  platforms: slice.platforms,
  install_name: slice.install_name,
  rpaths: slice.rpaths,
  dyld_environment: slice.dyld_environment,
  code_signature_present: slice.code_signature_present,
});

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
