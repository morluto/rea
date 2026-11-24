import { deb822Paragraphs } from "./aptRepositories.js";
import type { DesktopPackage, DesktopPackageFile } from "./desktopCapture.js";

/** The control fields REA asks `dpkg-deb --field` for, in its order. */
export const PACKAGE_FILE_FIELDS = [
  "Package",
  "Version",
  "Architecture",
  "Depends",
  "Pre-Depends",
] as const;

/** A package file's control fields, each relationship field split into its entries. */
export type PackageFileFields = Omit<
  DesktopPackageFile,
  "name" | "sha256" | "size"
>;

/** Debian policy's package names: lowercase letters, digits, `+`, `-` and `.`, at least two long. */
export const DEBIAN_PACKAGE_NAME = /^[a-z0-9][a-z0-9+.\x2d]+$/u;

/** The comma-separated entries of a relationship field, each on one line with its spacing collapsed. */
const relationEntries = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.replace(/\s+/gu, " ").trim())
    .filter((entry) => entry.length > 0);

/**
 * The fields `dpkg-deb --field FILE Package Version Architecture Depends
 * Pre-Depends` prints as `Name: value` lines, a field the file lacks left
 * out; undefined without Package, Version and Architecture.
 */
export const parseDpkgDebFields = (
  output: string,
): PackageFileFields | undefined => {
  const fields = deb822Paragraphs(output)[0];
  const name = fields?.get("package") ?? "";
  const version = fields?.get("version") ?? "";
  const architecture = fields?.get("architecture") ?? "";
  if (name.length === 0 || version.length === 0 || architecture.length === 0)
    return undefined;
  return {
    package: name,
    version,
    architecture,
    depends: relationEntries(fields?.get("depends")),
    pre_depends: relationEntries(fields?.get("pre-depends")),
  };
};

/** Why a package file is not the installed version, or undefined when its name, version and architecture are dpkg's. */
export const packageFileMismatch = (
  fields: PackageFileFields,
  installed: Pick<DesktopPackage, "name" | "version" | "architecture">,
): string | undefined => {
  const name = installed.name?.split(":")[0] ?? null;
  if (
    fields.package === name &&
    fields.version === installed.version &&
    fields.architecture === installed.architecture
  )
    return undefined;
  return `holds ${fields.package} ${fields.version} (${fields.architecture}), not the installed ${name ?? "package"} ${installed.version ?? "of unknown version"} (${installed.architecture ?? "unknown architecture"})`;
};

/**
 * The packages apt installs before a package file: the first alternative of
 * each Depends and Pre-Depends entry, without its architecture qualifier
 * (`:any`) or version constraint, once each. An entry whose first alternative
 * names no package is returned apart.
 */
export const dependencyPackages = (
  file: Pick<DesktopPackageFile, "depends" | "pre_depends">,
): {
  readonly names: readonly string[];
  readonly unread: readonly string[];
} => {
  const names = new Set<string>();
  const unread: string[] = [];
  for (const entry of [...file.depends, ...file.pre_depends]) {
    const [name = ""] = (entry.split("|")[0] ?? "").trim().split(/[\s(:[<]/u);
    if (DEBIAN_PACKAGE_NAME.test(name)) names.add(name);
    else unread.push(entry);
  }
  return { names: [...names], unread };
};
