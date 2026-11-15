import { z } from "zod";

import { coverageStatusSchema } from "../coverage.js";
import { compareUnicodeCodePoints as compare } from "../unicodeCodePointOrder.js";
import {
  anatomyNameIs,
  appleBundleSchema,
  contentDirectories,
  directoryOf,
  hasIosFamilyLayout,
  isWithin,
  joinPath,
  namedDirectory,
  type AppleAnatomyEntry,
  type AppleBundleAnatomy,
  type AppleBundleTree,
} from "./appleBundleAnatomy.js";

/** Apple's documented bundle layout that every placement rule cites. */
const APPLE_BUNDLE_PLACEMENT_REFERENCE =
  "https://developer.apple.com/documentation/bundleresources/placing-content-in-a-bundle";

const PLACEMENT_RULES = [
  "code-in-resource-location",
  "standalone-dynamic-library",
  "framework-in-nested-bundle",
  "framework-root-content",
  "grouping-directory-in-code-location",
  "dotted-directory-name",
] as const;
type PlacementRule = (typeof PLACEMENT_RULES)[number];

const APPLE_RULES: Readonly<Record<PlacementRule, string>> = {
  "code-in-resource-location":
    "Executable code means a Mach-O image, and resources are everything that's not code. macOS resources go in Contents/Resources/ and a framework's Versions/A/Resources/.",
  "standalone-dynamic-library":
    "iOS, watchOS, and tvOS support third-party frameworks but don't support third-party standalone dynamic libraries.",
  "framework-in-nested-bundle":
    "iOS and tvOS support frameworks and Swift system libraries at the topmost app level; a nested bundle, like an app extension, can't include a framework.",
  "framework-root-content":
    "The framework's root must contain only the Versions directory and symlinks. The Versions directory must contain only version directories and a symlink called Current.",
  "grouping-directory-in-code-location":
    "Each code location must contain a flat list of code content.",
  "dotted-directory-name":
    "The code-signing machinery assumes that any directory with a name that contains a dot is a bundle.",
};

/** These rules need facts the inventory projection does not read. */
const NOT_EVALUATED: Partial<Readonly<Record<PlacementRule, string>>> = {
  "standalone-dynamic-library":
    "Not evaluated: the bundle platform is not established from target content, such as the main executable's build-platform load command, and Mach-O file types are not read. A shallow layout does not tell iOS, tvOS, and watchOS from visionOS, which the rule does not name.",
  "framework-in-nested-bundle":
    "Not evaluated: the bundle platform is not established from target content, such as the main executable's build-platform load command. A shallow layout does not tell iOS and tvOS, which the rule names, from watchOS and visionOS.",
};

const pathSchema = z.string().min(1);
const machOImageSchema = z.strictObject({
  path: pathSchema,
  format: z.enum(["mach-o", "mach-o-universal"]),
});

const placementFindingSchema = z.strictObject({
  rules: z.array(z.enum(PLACEMENT_RULES)).min(1),
  bundle_path: pathSchema,
  bundle_layout: appleBundleSchema.shape.layout,
  location: pathSchema,
  path: pathSchema,
  entry_kind: z.enum(["file", "directory", "symlink"]),
  /** Placed Mach-O images at or below `path`; `mach_o_images` lists each once. */
  mach_o_image_count: z.int().min(0),
});

/** Static mismatches between observed placement and Apple's documented bundle layout. */
export const appleBundlePlacementSchema = z.strictObject({
  reference: z.literal(APPLE_BUNDLE_PLACEMENT_REFERENCE),
  rules: z.array(
    z.strictObject({
      rule: z.enum(PLACEMENT_RULES),
      apple_rule: z.string().min(1),
      status: coverageStatusSchema,
      evaluated_bundles: z.int().min(0),
      limitations: z.array(z.string()),
    }),
  ),
  findings: z.array(placementFindingSchema),
  /** Each Mach-O image under a finding's path, once, however many findings contain it. */
  mach_o_images: z.array(machOImageSchema),
});

type AppleBundlePlacement = z.infer<typeof appleBundlePlacementSchema>;
type Finding = z.infer<typeof placementFindingSchema>;
type Bundle = z.infer<typeof appleBundleSchema>;
type EntryKind = Finding["entry_kind"];
type Image = z.infer<typeof machOImageSchema>;

/** Code locations from Apple's table, relative to a bundle's content directory. */
const MACOS_CODE_LOCATIONS = [
  ["MacOS"],
  ["Frameworks"],
  ["PlugIns"],
  ["Helpers"],
  ["XPCServices"],
  ["Library", "Automator"],
  ["Library", "QuickLook"],
  ["Library", "LaunchServices"],
  ["Library", "LoginItems"],
  ["Library", "Spotlight"],
  ["Library", "SystemExtensions"],
] as const;
const FRAMEWORK_VERSION_CODE_LOCATIONS = [
  ["Frameworks"],
  ["PlugIns"],
  ["Helpers"],
] as const;
// AppClips/ and Watch/ are iOS-only; the layout does not establish iOS.
const IOS_FAMILY_CODE_LOCATIONS = [["Frameworks"], ["PlugIns"]] as const;

/**
 * Evaluate the placement rules whose facts the anatomy owns: observed layout,
 * entry kind, path, and Mach-O content format from magic. Archive members
 * (paths below another inventoried file, including an application found
 * inside an inventoried archive) are not placed in the bundle. Partial pages
 * can list an archive's members without the archive, so there a path is
 * placed only below listed directories; otherwise its membership is unknown.
 */
export const projectAppleBundlePlacement = (
  anatomy: AppleBundleAnatomy,
  inventoryComplete: boolean,
): AppleBundlePlacement => {
  const { tree, bundles } = anatomy;
  const placement = placementScope(anatomy, inventoryComplete);
  const unplaced: string[] = [];
  const evaluated = bundles.filter(({ path }) => {
    const scope = placement.directory(path);
    if (scope === "unknown") unplaced.push(path);
    return scope !== null && scope !== "unknown";
  });
  const bundlePaths = new Set(bundles.map(({ path }) => path));
  const targets = [
    ...evaluated.flatMap((bundle) => frameworkRootContent(bundle, tree)),
    ...evaluated.flatMap((bundle) =>
      groupingDirectories(bundle, tree, bundlePaths),
    ),
  ];
  const scanned = scanEntries(
    tree,
    placement,
    new Map(
      evaluated.flatMap((bundle) =>
        resourceDirectories(bundle, tree).map(
          (path) => [path, bundle] as const,
        ),
      ),
    ),
    { bundlePaths, targets, unplaced },
  );
  const groupingBundles = evaluated.filter(
    (bundle) => codeLocationNames(bundle).length > 0,
  ).length;
  const coverage = ruleCoverage(inventoryComplete, unplaced);
  const findings = [
    ...scanned.findings,
    ...targets.filter(
      (finding) =>
        finding.rules.includes("framework-root-content") ||
        finding.mach_o_image_count > 0,
    ),
  ];
  return {
    reference: APPLE_BUNDLE_PLACEMENT_REFERENCE,
    rules: [
      coverage(
        "code-in-resource-location",
        evaluated.filter(({ layout }) => layout !== "shallow").length,
        scanned.resourceUnknown,
      ),
      coverage("standalone-dynamic-library", 0, []),
      coverage("framework-in-nested-bundle", 0, []),
      coverage(
        "framework-root-content",
        evaluated.filter(isVersionedFramework).length,
        [],
      ),
      coverage(
        "grouping-directory-in-code-location",
        groupingBundles,
        scanned.groupingUnknown,
      ),
      coverage(
        "dotted-directory-name",
        groupingBundles,
        scanned.groupingUnknown,
      ),
    ],
    findings: findings.sort(
      (left, right) =>
        compare(left.path, right.path) ||
        compare(left.rules[0] ?? "", right.rules[0] ?? ""),
    ),
    mach_o_images: scanned.images.sort((left, right) =>
      compare(left.path, right.path),
    ),
  };
};

/**
 * Proper ancestors, outermost first; null when the path is outside every
 * application root or below an inventoried file such as an archive; "unknown"
 * when partial pages leave an enclosing path unlisted.
 */
type Placement = string[] | null | "unknown";

/** Paths inside an application root, excluding members of inventoried files such as archives. */
interface PlacementScope {
  readonly ancestors: (path: string) => Placement;
  /** The same decision for a directory, such as a bundle, that must itself be listed. */
  readonly directory: (path: string) => Placement;
}

const placementScope = (
  { tree, roots }: AppleBundleAnatomy,
  inventoryComplete: boolean,
): PlacementScope => {
  const files = new Set(fileEntries(tree).map(({ path }) => path));
  // Complete inventories list every enclosing entry, so an unlisted path there
  // is an implied directory. Partial pages can omit an archive's own entry.
  const unlisted = (path: string): boolean =>
    !inventoryComplete && !tree.listedDirectories.has(path);
  const ancestors = (path: string): Placement => {
    if (!roots.some((root) => isWithin(path, root))) return null;
    // A selected archive is the inventory itself, not an entry, so only a
    // file inside the inventory can make this path an archive member.
    const enclosing = ancestorsOf(path);
    if (enclosing.some((ancestor) => files.has(ancestor))) return null;
    return enclosing.some(unlisted) ? "unknown" : enclosing;
  };
  return {
    ancestors,
    directory: (path) => {
      const placement = ancestors(path);
      return path !== "." && Array.isArray(placement) && unlisted(path)
        ? "unknown"
        : placement;
    },
  };
};

/**
 * One pass over file entries: report each outermost Mach-O item under a
 * resource location, and count the Mach-O images under every finding. Nested
 * findings contain the same image, so the image record is retained once and
 * each containing finding only counts it.
 */
const scanEntries = (
  tree: AppleBundleTree,
  placement: PlacementScope,
  resources: ReadonlyMap<string, Bundle>,
  context: {
    readonly bundlePaths: ReadonlySet<string>;
    readonly targets: readonly Finding[];
    /** Receives examined paths whose archive membership is unknown. */
    readonly unplaced: string[];
  },
): {
  readonly findings: Finding[];
  readonly images: Image[];
  readonly resourceUnknown: string[];
  readonly groupingUnknown: string[];
} => {
  const targets = new Map<string, Finding[]>();
  for (const target of context.targets) {
    const scoped = targets.get(target.path) ?? [];
    scoped.push(target);
    targets.set(target.path, scoped);
  }
  const findings = new Map<string, Finding>();
  const images: Image[] = [];
  const resourceUnknown: string[] = [];
  const groupingUnknown: string[] = [];
  for (const entry of fileEntries(tree)) {
    // The index keeps one occurrence of a repeated path, so its content is unknown.
    const content = tree.duplicateFiles.has(entry.path)
      ? "unknown"
      : contentOf(entry);
    if (content === "other") continue;
    const ancestors = placement.ancestors(entry.path);
    if (ancestors === null) continue;
    if (ancestors === "unknown") {
      context.unplaced.push(entry.path);
      continue;
    }
    const containing = [...ancestors, entry.path].flatMap(
      (path) => targets.get(path) ?? [],
    );
    const index = ancestors.findIndex((path) => resources.has(path));
    const location = ancestors[index];
    const owner = location === undefined ? undefined : resources.get(location);
    if (content === "unknown") {
      if (owner !== undefined) resourceUnknown.push(entry.path);
      if (
        containing.some(({ rules }) =>
          rules.includes("grouping-directory-in-code-location"),
        )
      )
        groupingUnknown.push(entry.path);
      continue;
    }
    if (location !== undefined && owner !== undefined) {
      // The outermost nested bundle is the misplaced item; otherwise the file is.
      const item =
        ancestors
          .slice(index + 1)
          .find((path) => context.bundlePaths.has(path)) ?? entry.path;
      const finding =
        findings.get(item) ??
        createFinding(["code-in-resource-location"], owner, {
          location,
          path: item,
          kind: item === entry.path ? "file" : "directory",
        });
      findings.set(item, finding);
      containing.push(finding);
    }
    if (containing.length === 0) continue;
    images.push({ path: entry.path, format: content });
    for (const finding of containing) finding.mach_o_image_count += 1;
  }
  return {
    findings: [...findings.values()],
    images,
    resourceUnknown,
    groupingUnknown,
  };
};

const ruleCoverage =
  (inventoryComplete: boolean, unplaced: readonly string[]) =>
  (
    rule: PlacementRule,
    evaluatedBundles: number,
    unknown: readonly string[],
  ): AppleBundlePlacement["rules"][number] => {
    const skipped = NOT_EVALUATED[rule];
    if (skipped !== undefined)
      return {
        rule,
        apple_rule: APPLE_RULES[rule],
        status: "unknown",
        evaluated_bundles: 0,
        limitations: [skipped],
      };
    const limitations = [
      ...(inventoryComplete
        ? []
        : ["Source inventory coverage is partial; absence is unknown."]),
      ...unknownFormatLimitation(unknown),
      ...unplacedLimitation(unplaced),
    ];
    return {
      rule,
      apple_rule: APPLE_RULES[rule],
      status: limitations.length === 0 ? "complete" : "partial",
      evaluated_bundles: evaluatedBundles,
      limitations,
    };
  };

const createFinding = (
  rules: Finding["rules"],
  bundle: Bundle,
  {
    location,
    path,
    kind,
  }: {
    readonly location: string;
    readonly path: string;
    readonly kind: EntryKind;
  },
): Finding => ({
  rules,
  bundle_path: bundle.path,
  bundle_layout: bundle.layout,
  location: location === "" ? "." : location,
  path,
  entry_kind: kind,
  mach_o_image_count: 0,
});

const fileEntries = (tree: AppleBundleTree): AppleAnatomyEntry[] =>
  [...tree.files.values()].flatMap((children) => [...children.values()]);

const contentOf = ({
  component,
}: AppleAnatomyEntry): Image["format"] | "unknown" | "other" => {
  if (component === undefined || component.format === "unknown")
    return "unknown";
  if (component.format === "mach-o" || component.format === "mach-o-universal")
    return component.format;
  return "other";
};

/** Proper ancestor paths, outermost first. */
const ancestorsOf = (path: string): string[] => {
  const ancestors: string[] = [];
  for (
    let index = path.indexOf("/");
    index >= 0;
    index = path.indexOf("/", index + 1)
  )
    ancestors.push(path.slice(0, index));
  return ancestors;
};

const unknownFormatLimitation = (paths: readonly string[]): string[] => {
  const first = [...paths].sort(compare)[0];
  if (first === undefined) return [];
  const count = paths.length;
  return [
    `${count} examined ${count === 1 ? "file has" : "files have"} no byte-established format (unknown, unavailable, outside the supplied pages, or a path the inventory repeats); whether ${count === 1 ? "it is a Mach-O image" : "they are Mach-O images"} is unknown. First path: ${JSON.stringify(first)}.`,
  ];
};

const unplacedLimitation = (paths: readonly string[]): string[] => {
  const first = [...paths].sort(compare)[0];
  if (first === undefined) return [];
  const count = paths.length;
  const subject = count === 1 ? "it is" : "they are";
  return [
    `${count} examined ${count === 1 ? "path lies" : "paths lie"} below a path the supplied inventory pages do not list, so whether ${subject} inside an inventoried archive is unknown; ${subject} not evaluated. First path: ${JSON.stringify(first)}.`,
  ];
};

/** Resource locations of observed macOS layouts; shallow layouts mix code and resources. */
const resourceDirectories = (
  bundle: Bundle,
  tree: AppleBundleTree,
): string[] =>
  bundle.layout === "shallow"
    ? []
    : contentDirectories(bundle.path, bundle.layout, tree).flatMap(
        (directory) => {
          const resources = namedDirectory(tree, directory, "Resources");
          return resources === null ? [] : [resources];
        },
      );

/** Child names with one kind each; a file wins over directories implied by its members. */
const childKinds = (
  tree: AppleBundleTree,
  directory: string,
): Map<string, EntryKind> => {
  const kinds = new Map<string, EntryKind>();
  for (const name of tree.files.get(directory)?.keys() ?? [])
    kinds.set(name, "file");
  for (const name of tree.links.get(directory) ?? [])
    if (!kinds.has(name)) kinds.set(name, "symlink");
  for (const name of tree.directories.get(directory) ?? [])
    if (!kinds.has(name)) kinds.set(name, "directory");
  return kinds;
};

/**
 * Framework-only rules need both facts: the anatomy derives the versioned
 * layout from an observed Versions/ directory, which any bundle can contain,
 * and the framework role from the bundle's extension.
 */
const isVersionedFramework = ({ layout, role }: Bundle): boolean =>
  layout === "versioned-framework" && role === "framework";

/** Root entries other than Versions and symlinks, and Versions entries other than versions and Current. */
const frameworkRootContent = (
  bundle: Bundle,
  tree: AppleBundleTree,
): Finding[] => {
  if (!isVersionedFramework(bundle)) return [];
  const root = directoryOf(bundle.path);
  const versions = namedDirectory(tree, root, "Versions");
  const offender = (location: string, name: string, kind: EntryKind) =>
    createFinding(["framework-root-content"], bundle, {
      location,
      path: joinPath(location, name),
      kind,
    });
  const targets: Finding[] = [];
  for (const [name, kind] of childKinds(tree, root))
    if (kind !== "symlink" && joinPath(root, name) !== versions)
      targets.push(offender(root, name, kind));
  if (versions === null) return targets;
  for (const [name, kind] of childKinds(tree, versions)) {
    const current = anatomyNameIs(name, "Current");
    const allowed =
      (kind === "directory" && !current) || (kind === "symlink" && current);
    if (!allowed) targets.push(offender(versions, name, kind));
  }
  return targets;
};

const codeLocationNames = (bundle: Bundle): readonly (readonly string[])[] => {
  if (bundle.layout === "macos-deep") return MACOS_CODE_LOCATIONS;
  if (isVersionedFramework(bundle)) return FRAMEWORK_VERSION_CODE_LOCATIONS;
  return hasIosFamilyLayout(bundle) ? IOS_FAMILY_CODE_LOCATIONS : [];
};

const codeLocations = (bundle: Bundle, tree: AppleBundleTree): string[] =>
  contentDirectories(bundle.path, bundle.layout, tree).flatMap((directory) =>
    codeLocationNames(bundle).flatMap((names) => {
      let location: string | null = directory;
      for (const name of names)
        location =
          location === null ? null : namedDirectory(tree, location, name);
      return location === null ? [] : [location];
    }),
  );

/** Directories directly in a code location that the anatomy does not identify as bundles. */
const groupingDirectories = (
  bundle: Bundle,
  tree: AppleBundleTree,
  bundlePaths: ReadonlySet<string>,
): Finding[] =>
  codeLocations(bundle, tree).flatMap((location) =>
    [...childKinds(tree, location)].flatMap(([name, kind]) => {
      const path = joinPath(location, name);
      if (kind !== "directory" || bundlePaths.has(path)) return [];
      const rules: Finding["rules"] = name.includes(".")
        ? ["grouping-directory-in-code-location", "dotted-directory-name"]
        : ["grouping-directory-in-code-location"];
      return [
        createFinding(rules, bundle, { location, path, kind: "directory" }),
      ];
    }),
  );
