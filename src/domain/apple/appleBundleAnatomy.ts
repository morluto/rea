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
    const ios = /^(Payload\/[^/]+\.app)(?:\/|$)/u.exec(path);
    if (ios?.[1] !== undefined) {
      found.add(ios[1]);
      continue;
    }
    const segments = path.split("/");
    const index = segments.findIndex(
      (segment, position) =>
        /\.app$/iu.test(segment) && segments[position + 1] === "Contents",
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
  if (names?.has("Contents") === true) return "macos-deep";
  if (names?.has("Versions") === true) return "versioned-framework";
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
    if (container === "PlugIns") return "plug-in";
    return container === "Resources" ? "resource-bundle" : "bundle";
  }
  if (!name.endsWith(".app")) return "plug-in";
  if (container === "LoginItems" && segments.at(-3) === "Library")
    return "login-item";
  if (container === "Helpers") return "helper-application";
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
  if (layout === "macos-deep") return [joinPath(directory, "Contents")];
  if (layout === "shallow") return [directory];
  const versions = joinPath(directory, "Versions");
  // Only real version directories count: Current is a symlink, and files
  // such as .DS_Store are not versions.
  return [...(tree.children.get(versions) ?? [])]
    .filter((version) => version !== "Current")
    .map((version) => joinPath(versions, version))
    .filter((version) => tree.directories.has(version))
    .sort(compare);
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
  const candidates = directories
    .map((directory) =>
      joinPath(
        directory,
        layout === "versioned-framework"
          ? "Resources/Info.plist"
          : "Info.plist",
      ),
    )
    .filter((path) => tree.files.has(path));
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
};

const executableCandidates = (
  bundle: string,
  layout: Bundle["layout"],
  tree: Tree,
): string[] =>
  contentDirectories(bundle, layout, tree)
    .flatMap((directory) =>
      directFiles(
        layout === "macos-deep" ? joinPath(directory, "MacOS") : directory,
        tree,
      ),
    )
    .filter((path) =>
      MACH_O_FORMATS.includes(tree.files.get(path)?.format ?? ""),
    );

const signingPaths = (
  bundle: string,
  layout: Bundle["layout"],
  tree: Tree,
): string[] =>
  contentDirectories(bundle, layout, tree)
    .flatMap((directory) => [
      joinPath(directory, "_CodeSignature/CodeResources"),
      joinPath(directory, "embedded.provisionprofile"),
      joinPath(directory, "embedded.mobileprovision"),
    ])
    .filter((path) => tree.files.has(path))
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
