import {
  compatibleSlice,
  directoryOf,
  expandPrefix,
  joinPath,
  resolveTreePath,
  type Expansion,
} from "./dyldPaths.js";
import {
  DYLIB_RESOLUTION_LIMITATIONS,
  deriveFindings,
  cacheMismatch,
  sharedCacheLimitations,
  type UnservedRoot,
} from "./dylibResolutionFindings.js";
import type {
  MachoDependency,
  MachoSlice,
  MachoImageFacts,
  DylibTreeView,
  DylibSharedCacheView,
  DylibCandidate,
  DylibEdge,
  DylibTrace,
} from "./dylibResolutionSchema.js";

export {
  dylibResolutionInputSchema,
  machoSliceSchema,
  dylibResolutionResultSchema,
  type MachoDependency,
  type MachoSlice,
  type MachoImageFacts,
  type DylibTreeEntry,
  type DylibTreeView,
  type DylibSharedCacheView,
  type DylibResolutionResult,
  type DylibEdge,
  type DylibFinding,
  type DylibTrace,
} from "./dylibResolutionSchema.js";

type Candidate = DylibCandidate;
type Edge = DylibEdge;

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
  readonly executable: string | null;
  readonly loaded: Map<string, LoadedImage>;
  readonly byInstallName: Map<string, string>;
  readonly images: Map<string, MachoImageFacts>;
  /** The supplied cache, when it serves this process's architecture and platform. */
  readonly sharedCache: DylibSharedCacheView | undefined;
  /** Cached install paths whose subcache bytes were unavailable, across processes. */
  readonly unverifiedCacheImages: Set<string>;
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
  if (template.expansion.scope === "outside") {
    const sharedCache = context.sharedCache;
    const cached = sharedCache?.lookup(template.expansion.path) ?? "absent";
    if (cached === "mapped" && sharedCache !== undefined) {
      // Address coverage is not a load. Confirm a compatible Mach-O without
      // retaining its commands, so cache images stay leaves.
      const facts = await sharedCache.image(template.expansion.path);
      if (
        facts?.status === "parsed" &&
        compatibleSlice(facts.slices, context.architecture) !== undefined
      )
        return {
          ...base,
          outcome: "shared-cache",
          resolved_path: template.expansion.path,
        };
      context.unverifiedCacheImages.add(template.expansion.path);
      return { ...base, outcome: "undetermined", resolved_path: null };
    }
    // Listed in the cache, but its subcache is unavailable: dyld might load it.
    if (cached === "unverified") {
      context.unverifiedCacheImages.add(template.expansion.path);
      return { ...base, outcome: "undetermined", resolved_path: null };
    }
    return { ...base, outcome: "outside-target", resolved_path: null };
  }
  if (template.expansion.scope === "undetermined")
    return { ...base, outcome: "undetermined", resolved_path: null };
  const lookup = await resolveTreePath(context.view, template.expansion.path);
  if (lookup.kind === "escapes")
    return { ...base, outcome: "escapes-target", resolved_path: null };
  if (lookup.kind !== "file")
    return { ...base, outcome: "absent", resolved_path: null };
  const facts = await imageFacts(context, lookup.path);
  const outcome: Candidate["outcome"] =
    facts.status !== "parsed"
      ? facts.status
      : compatibleSlice(facts.slices, context.architecture) === undefined
        ? "architecture-missing"
        : "resolved";
  return { ...base, outcome, resolved_path: lookup.path };
};

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
    if (candidate.outcome === "shared-cache")
      return {
        status: external ? "conditional" : "shared-cache",
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
      if (
        candidate.outcome === "resolved" ||
        candidate.outcome === "shared-cache"
      )
        break;
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
    readonly sharedCache?: DylibSharedCacheView;
    readonly signal?: AbortSignal;
  },
): Promise<DylibTrace> => {
  const images = new Map<string, MachoImageFacts>();
  for (const path of request.unclassified ?? [])
    images.set(path, await view.image(path));
  const roots: DylibTrace["roots"][number][] = [];
  const edges: Edge[] = [];
  const withoutArchitecture: string[] = [];
  const unserved: UnservedRoot[] = [];
  const unverifiedCacheImages = new Set<string>();
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
      const mismatch =
        request.sharedCache === undefined
          ? undefined
          : cacheMismatch(request.sharedCache, slice);
      if (mismatch !== undefined)
        unserved.push({
          image: root,
          architecture: slice.architecture,
          reason: mismatch,
        });
      edges.push(
        ...(await traceProcess(
          {
            view,
            root,
            architecture: slice.architecture,
            executable: slice.file_type === "execute" ? root : null,
            loaded: new Map(),
            byInstallName: new Map(),
            images,
            sharedCache:
              mismatch === undefined ? request.sharedCache : undefined,
            unverifiedCacheImages,
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
  // LC_DYLD_ENVIRONMENT can prepend search paths dyld honors at launch; its
  // settings are reported but not modeled, so resolutions stay conditional.
  const environmentRoots = roots.filter(({ image, architecture }) => {
    const facts = images.get(image);
    return (
      facts?.status === "parsed" &&
      (facts.slices.find((s) => s.architecture === architecture)
        ?.dyld_environment.length ?? 0) > 0
    );
  });
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
        unparsed.length === 0 &&
        withoutArchitecture.length === 0 &&
        unverifiedCacheImages.size === 0 &&
        environmentRoots.length === 0
          ? "complete"
          : "partial",
      unparsed_images: unparsed,
      roots_without_architecture: withoutArchitecture,
      unverified_shared_cache_images: [...unverifiedCacheImages].sort(compare),
    },
    limitations: [
      ...DYLIB_RESOLUTION_LIMITATIONS,
      ...sharedCacheLimitations(request.sharedCache, unserved),
      ...(edges.some(
        (edge) =>
          edge.command !== "LC_LAZY_LOAD_DYLIB" &&
          edge.candidates.some(({ outcome }) => outcome === "shared-cache"),
      )
        ? [
            "Cache-backed images are leaf references: their load commands and transitive dependencies were not traversed. Complete coverage describes the selected roots and in-root images, not a complete process-wide dependency graph. Use inspect_dyld_shared_cache with selected images to inspect cached load commands.",
          ]
        : []),
      ...(environmentRoots.length === 0
        ? []
        : [
            `Roots ${environmentRoots.map(({ image }) => image).join(", ")} set dyld environment variables through LC_DYLD_ENVIRONMENT; their resolutions are conditional because those search paths are not modeled.`,
          ]),
    ],
  };
};

const withoutDependencies = (
  slice: MachoSlice,
): Omit<MachoSlice, "dependencies"> => ({
  architecture: slice.architecture,
  file_type: slice.file_type,
  install_name: slice.install_name,
  rpaths: slice.rpaths,
  dyld_environment: slice.dyld_environment,
  code_signature_present: slice.code_signature_present,
  platforms: slice.platforms,
});

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
