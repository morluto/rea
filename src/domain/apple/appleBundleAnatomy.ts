import { z } from "zod";

import { digestSchema, prefixedDigestSchema } from "../digests.js";

const pathSchema = z.string().min(1);

const BUNDLE_EXTENSION =
  /\.(?:app|appex|xpc|framework|systemextension|dext|bundle|plugin|qlgenerator|mdimporter)$/iu;
const MACH_O_FORMATS: readonly string[] = ["mach-o", "mach-o-universal"];

/** One inventoried file or directory with its content identity. */
export const appleComponentSchema = z.strictObject({
  path: pathSchema,
  artifact_id: prefixedDigestSchema("art"),
  sha256: digestSchema,
  format: z.string().min(1),
});

/** One application root or nested bundle classified by path convention. */
export const appleBundleSchema = z.strictObject({
  path: pathSchema,
  parent_path: pathSchema.nullable(),
  layout: z.enum(["shallow", "macos-deep", "versioned-framework"]),
  role: z.enum([
    "application",
    "app-extension",
    "xpc-service",
    "framework",
    "login-item",
    "system-extension",
    "driver-extension",
    "plug-in",
    "resource-bundle",
    "bundle",
    "helper-application",
    "nested-application",
  ]),
  role_basis: z.literal("path-convention"),
  info_plist_path: pathSchema.nullable(),
  executable_candidates: z.array(pathSchema),
  signing_paths: z.array(pathSchema),
});

type Component = z.infer<typeof appleComponentSchema>;
type Bundle = z.infer<typeof appleBundleSchema>;

/** One inventory occurrence; symlinks and directories may lack content identity. */
export interface AppleInventoryEntry {
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink" | "slice";
  readonly component: Component | undefined;
}
type Entry = AppleInventoryEntry;

/** Report whether an inventory format is a thin or universal Mach-O. */
export const isMachOFormat = (format: string): boolean =>
  MACH_O_FORMATS.includes(format);

/** AppleDouble metadata written beside archived files (`._name`, `__MACOSX/`). */
export const isSidecar = (path: string): boolean => {
  const segments = path.split("/");
  return (
    segments.includes("__MACOSX") || (segments.at(-1) ?? "").startsWith("._")
  );
};

export const isWithin = (path: string, root: string): boolean =>
  root === "." || path === root || path.startsWith(`${root}/`);

/**
 * English (en-US) case fold used only for Apple's fixed anatomy vocabulary.
 * Reported paths keep the archive spelling. Inventory identity stays case-sensitive.
 */
export const anatomyNameIs = (actual: string, expected: string): boolean =>
  actual.toLocaleLowerCase("en-US") === expected.toLocaleLowerCase("en-US");

/** Directory entry that folds to one vocabulary word. The exact spelling wins. */
export const anatomyChild = (
  names: ReadonlySet<string> | undefined,
  expected: string,
): string | null => {
  if (names === undefined) return null;
  let exact: string | undefined;
  let folded: string | undefined;
  for (const name of names) {
    if (name === expected) exact = name;
    else if (
      anatomyNameIs(name, expected) &&
      (folded === undefined || compare(name, folded) < 0)
    )
      folded = name;
  }
  return exact ?? folded ?? null;
};

/**
 * Whether `path`'s tail matches anatomy vocabulary. `*` matches one segment
 * that is not itself a vocabulary comparison.
 */
export const anatomyTailMatches = (
  path: string,
  expected: readonly string[],
): boolean => {
  const actual = path.split("/");
  if (actual.length < expected.length) return false;
  const tail = actual.slice(-expected.length);
  return expected.every((name, index) => {
    const segment = tail[index];
    if (segment === undefined || segment.length === 0) return false;
    return name === "*" || anatomyNameIs(segment, name);
  });
};

/**
 * Outermost iOS (`Payload/X.app`) and macOS (`X.app/Contents/…`) applications.
 * An inventoried `.app` directory is its own root, `.`.
 */
export const applicationRoots = (
  entries: readonly Entry[],
  subject: { readonly name: string; readonly format: string },
): string[] => {
  // A selected `.app` directory is the application, even when its inventory
  // is partial or lacks Contents/; coverage and limitations describe that.
  if (subject.format === "directory" && /\.app$/iu.test(subject.name))
    return ["."];
  const found = new Set<string>();
  for (const { path } of entries) {
    if (isSidecar(path)) continue;
    const segments = path.split("/");
    const app = segments[1];
    if (
      anatomyNameIs(segments[0] ?? "", "Payload") &&
      app !== undefined &&
      /\.app$/iu.test(app)
    ) {
      found.add(`${segments[0]}/${app}`);
      continue;
    }
    const index = segments.findIndex(
      (segment, position) =>
        /\.app$/iu.test(segment) &&
        anatomyNameIs(segments[position + 1] ?? "", "Contents"),
    );
    if (index >= 0) found.add(segments.slice(0, index + 1).join("/"));
  }
  const roots = [...found];
  return roots
    .filter(
      (root) => !roots.some((other) => other !== root && isWithin(root, other)),
    )
    .sort(compare);
};

export const detectBundles = (
  entries: readonly Entry[],
  roots: readonly string[],
): Bundle[] => {
  const paths = new Set<string>(roots);
  for (const { path, kind } of entries) {
    if (isSidecar(path)) continue;
    const root = roots.find((candidate) => isWithin(path, candidate));
    if (root === undefined) continue;
    const segments = path.split("/");
    const start = root === "." ? 0 : root.split("/").length;
    for (let index = start; index < segments.length; index++) {
      const segment = segments[index] ?? "";
      const leaf = index === segments.length - 1;
      // A symlink or file named like a bundle has no observed contents.
      if (BUNDLE_EXTENSION.test(segment) && (!leaf || kind === "directory"))
        paths.add(segments.slice(0, index + 1).join("/"));
    }
  }
  const tree = indexTree(entries);
  return [...paths].sort(compare).map((path) => {
    const layout = bundleLayout(path, tree);
    return {
      path,
      parent_path: enclosingBundle(path, paths),
      layout,
      role: roots.includes(path) ? "application" : bundleRole(path),
      role_basis: "path-convention",
      info_plist_path: infoPlistPath(path, layout, tree),
      executable_candidates: executableCandidates(path, layout, tree),
      signing_paths: signingPaths(path, layout, tree),
    } satisfies Bundle;
  });
};

/** Directory children (including implied ancestors) and files, indexed once. */
interface Tree {
  readonly children: ReadonlyMap<string, ReadonlySet<string>>;
  readonly files: ReadonlyMap<string, Component>;
  /** Paths observed as directories, or implied by a deeper path. */
  readonly directories: ReadonlySet<string>;
}

const indexTree = (entries: readonly Entry[]): Tree => {
  const children = new Map<string, Set<string>>();
  const files = new Map<string, Component>();
  const directories = new Set<string>();
  for (const { path, kind, component } of entries) {
    if (isSidecar(path)) continue;
    if (kind === "file" && component !== undefined) files.set(path, component);
    if (kind === "directory") directories.add(path);
    const segments = path.split("/");
    let parent = "";
    for (const segment of segments) {
      const names = children.get(parent) ?? new Set<string>();
      names.add(segment);
      children.set(parent, names);
      parent = joinPath(parent, segment);
      if (parent !== path) directories.add(parent);
    }
  }
  return { children, files, directories };
};

const joinPath = (directory: string, name: string): string =>
  directory === "" ? name : `${directory}/${name}`;

const directoryOf = (bundle: string): string => (bundle === "." ? "" : bundle);

const enclosingBundle = (
  path: string,
  bundles: ReadonlySet<string>,
): string | null => {
  if (path === ".") return null;
  const segments = path.split("/");
  for (let length = segments.length - 1; length > 0; length--) {
    const candidate = segments.slice(0, length).join("/");
    if (bundles.has(candidate)) return candidate;
  }
  return bundles.has(".") ? "." : null;
};

const bundleLayout = (bundle: string, tree: Tree): Bundle["layout"] => {
  const names = tree.children.get(directoryOf(bundle));
  if (anatomyChild(names, "Contents") !== null) return "macos-deep";
  if (anatomyChild(names, "Versions") !== null) return "versioned-framework";
  return "shallow";
};

const bundleRole = (bundle: string): Bundle["role"] => {
  const segments = bundle.split("/");
  const name = (segments.at(-1) ?? "").toLowerCase();
  const container = segments.at(-2);
  if (name.endsWith(".appex")) return "app-extension";
  if (name.endsWith(".xpc")) return "xpc-service";
  if (name.endsWith(".framework")) return "framework";
  if (name.endsWith(".systemextension")) return "system-extension";
  if (name.endsWith(".dext")) return "driver-extension";
  if (name.endsWith(".bundle")) {
    if (anatomyNameIs(container ?? "", "PlugIns")) return "plug-in";
    return anatomyNameIs(container ?? "", "Resources")
      ? "resource-bundle"
      : "bundle";
  }
  if (!name.endsWith(".app")) return "plug-in";
  if (
    anatomyNameIs(container ?? "", "LoginItems") &&
    anatomyNameIs(segments.at(-3) ?? "", "Library")
  )
    return "login-item";
  if (anatomyNameIs(container ?? "", "Helpers")) return "helper-application";
  return "nested-application";
};

/** Files directly inside one directory; nested bundles are deeper paths. */
const directFiles = (directory: string, tree: Tree): string[] =>
  [...(tree.children.get(directory) ?? [])]
    .map((name) => joinPath(directory, name))
    .filter((path) => tree.files.has(path))
    .sort(compare);

/** Content directories; `Versions/Current` is a symlink outside the inventory. */
const contentDirectories = (
  bundle: string,
  layout: Bundle["layout"],
  tree: Tree,
): string[] => {
  const directory = directoryOf(bundle);
  if (layout === "macos-deep") {
    const contents = namedChild(tree, directory, "Contents");
    return contents === null ? [] : [contents];
  }
  if (layout === "shallow") return [directory];
  const versions = namedChild(tree, directory, "Versions");
  if (versions === null) return [];
  // Only real version directories count: Current is a symlink, and files
  // such as .DS_Store are not versions.
  return [...(tree.children.get(versions) ?? [])]
    .filter((version) => !anatomyNameIs(version, "Current"))
    .map((version) => joinPath(versions, version))
    .filter((version) => tree.directories.has(version))
    .sort(compare);
};

/** Child path using the archive's spelling of one anatomy name. */
const namedChild = (
  tree: Tree,
  directory: string,
  expected: string,
): string | null => {
  const name = anatomyChild(tree.children.get(directory), expected);
  return name === null ? null : joinPath(directory, name);
};

const infoPlistPath = (
  bundle: string,
  layout: Bundle["layout"],
  tree: Tree,
): string | null => {
  const directories = contentDirectories(bundle, layout, tree);
  // With several real versions, Versions/Current (a symlink outside the
  // inventory) decides which plist applies, so the plist stays unknown.
  if (directories.length !== 1) return null;
  const directory = directories[0];
  if (directory === undefined) return null;
  const parent =
    layout === "versioned-framework"
      ? namedChild(tree, directory, "Resources")
      : directory;
  if (parent === null) return null;
  const info = namedChild(tree, parent, "Info.plist");
  return info !== null && tree.files.has(info) ? info : null;
};

const executableCandidates = (
  bundle: string,
  layout: Bundle["layout"],
  tree: Tree,
): string[] =>
  contentDirectories(bundle, layout, tree)
    .flatMap((directory) => {
      const executableDirectory =
        layout === "macos-deep"
          ? namedChild(tree, directory, "MacOS")
          : directory;
      return executableDirectory === null
        ? []
        : directFiles(executableDirectory, tree);
    })
    .filter((path) =>
      MACH_O_FORMATS.includes(tree.files.get(path)?.format ?? ""),
    );

const signingPaths = (
  bundle: string,
  layout: Bundle["layout"],
  tree: Tree,
): string[] =>
  contentDirectories(bundle, layout, tree)
    .flatMap((directory) => {
      const signature = namedChild(tree, directory, "_CodeSignature");
      return [
        signature === null
          ? null
          : namedChild(tree, signature, "CodeResources"),
        namedChild(tree, directory, "embedded.provisionprofile"),
        namedChild(tree, directory, "embedded.mobileprovision"),
      ];
    })
    .filter((path): path is string => path !== null && tree.files.has(path))
    .sort(compare);

/** Platforms of application roots whose layout was observed, not assumed. */
export const platformsOf = (bundles: readonly Bundle[]): ("ios" | "macos")[] =>
  [
    ...new Set(
      bundles.flatMap(({ role, layout, info_plist_path: plist }) => {
        if (role !== "application") return [];
        if (layout === "macos-deep") return ["macos" as const];
        // An empty or partial root has no Contents/ either; require Info.plist.
        if (layout === "shallow" && plist !== null) return ["ios" as const];
        return [];
      }),
    ),
  ].sort(compare);

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
