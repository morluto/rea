/** Facts `dpkg-query -W` reports for one installed package. */
export interface DebianPackageStatus {
  readonly name: string;
  readonly version: string;
  readonly architecture: string;
  readonly status: string;
}

/** Format string passed to `dpkg-query -W -f`. */
export const DPKG_STATUS_FORMAT =
  "${Package}\\t${Version}\\t${Architecture}\\t${db:Status-Status}\\n";

/** Package names that own a path, from `dpkg-query -S` output. */
export const parseDpkgOwners = (
  output: string,
  path: string,
): readonly string[] => {
  const owners = new Set<string>();
  for (const line of output.split("\n")) {
    if (line.startsWith("diversion ") || !line.endsWith(`: ${path}`)) continue;
    for (const name of line.slice(0, -(path.length + 2)).split(","))
      if (name.trim().length > 0) owners.add(name.trim());
  }
  return [...owners];
};

/** Parse one `dpkg-query -W -f DPKG_STATUS_FORMAT` line. */
export const parseDpkgStatus = (
  output: string,
): DebianPackageStatus | undefined => {
  const [name, version, architecture, status] = (
    output.split("\n")[0] ?? ""
  ).split("\t");
  if (
    name === undefined ||
    version === undefined ||
    architecture === undefined ||
    status === undefined ||
    name.length === 0
  )
    return undefined;
  return { name, version, architecture, status };
};

const POLICY_VERSION = /^ (?:\*\*\*| {3}) (?<version>\S+) -?\d+$/u;
const POLICY_SOURCE = /^ {8}-?\d+ (?<source>.+)$/u;
const DPKG_STATUS_SOURCE = "/var/lib/dpkg/status";

/**
 * The package sources `apt-cache policy` lists for the installed version,
 * excluding the dpkg status database every installed version carries.
 */
export const parseAptPolicySources = (output: string): readonly string[] => {
  const sources: string[] = [];
  let installed = false;
  for (const line of output.split("\n")) {
    const version = POLICY_VERSION.exec(line);
    if (version !== null) {
      installed = line.startsWith(" ***");
      continue;
    }
    const source = POLICY_SOURCE.exec(line)?.groups?.source?.trim();
    if (installed && source !== undefined && source !== DPKG_STATUS_SOURCE)
      sources.push(source);
  }
  return sources;
};

/** Packaging recognised from an executable's location before asking dpkg. */
export type PathPackage =
  | {
      readonly kind: "snap";
      readonly name: string;
      readonly revision: string | null;
    }
  | { readonly kind: "flatpak"; readonly name: string }
  | { readonly kind: "appimage" };

/** Recognise snap, flatpak and AppImage installs from a resolved path. */
export const packageFromPath = (path: string): PathPackage | undefined => {
  const snap = /^\/snap\/(?<name>[^/]+)\/(?<revision>[^/]+)\//u.exec(path);
  if (snap?.groups?.name !== undefined && snap.groups.name !== "bin")
    return {
      kind: "snap",
      name: snap.groups.name,
      revision: snap.groups.revision ?? null,
    };
  const snapBin = /^\/snap\/bin\/(?<name>[^/.]+)/u.exec(path);
  if (snapBin?.groups?.name !== undefined)
    return { kind: "snap", name: snapBin.groups.name, revision: null };
  const flatpak =
    /\/flatpak\/(?:app\/(?<app>[^/]+)\/|exports\/bin\/(?<bin>[^/]+)$)/u.exec(
      path,
    );
  const flatpakName = flatpak?.groups?.app ?? flatpak?.groups?.bin;
  if (flatpakName !== undefined) return { kind: "flatpak", name: flatpakName };
  if (/\.appimage$/iu.test(path)) return { kind: "appimage" };
  return undefined;
};

/** ELF images that carry the AppImage type 1 or type 2 magic at byte 8. */
export const isAppImageHeader = (header: Uint8Array): boolean =>
  header.length >= 11 &&
  header[0] === 0x7f &&
  header[1] === 0x45 &&
  header[2] === 0x4c &&
  header[3] === 0x46 &&
  header[8] === 0x41 &&
  header[9] === 0x49 &&
  (header[10] === 0x01 || header[10] === 0x02);
