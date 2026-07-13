import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DOWNLOAD_PREFIX = "https://www.hopperapp.com:443/downloader/public/";
const MAX_PACKAGE_BYTES = 100_000_000;
const SUPPORTED_HOPPER_SHA256 =
  "0294ced141cc373468ee22d8343e7dac41980cb05a937994ca81c9f09afe7ded";
interface LinuxHopperRelease {
  readonly filename: string;
  readonly file_length: string;
  readonly file_hash: string;
}
const SUPPORTED_RELEASES: Readonly<
  Record<LinuxPackageFamily, LinuxHopperRelease>
> = {
  deb: {
    filename: `${DOWNLOAD_PREFIX}Hopper-6.4.2-Linux-demo.deb`,
    file_length: "35755772",
    file_hash: "e4f79dff602648a8ff4a88b773875b6bfac0dc65",
  },
  rpm: {
    filename: `${DOWNLOAD_PREFIX}Hopper-6.4.2-Linux-demo.rpm`,
    file_length: "32264475",
    file_hash: "b9a65f2f583a386d440d4401d9140aef3bf305de",
  },
  arch: {
    filename: `${DOWNLOAD_PREFIX}Hopper-6.4.2-Linux-demo.pkg.tar.xz`,
    file_length: "29405968",
    file_hash: "92d780b61cab38eda95dc4112dee4fbeb0920f46",
  },
};

export type LinuxPackageFamily = "deb" | "rpm" | "arch";

/** Parsed Linux distribution information used for support and package selection. */
export interface LinuxDistribution {
  readonly id: string;
  readonly versionId?: string;
  readonly packageFamily: LinuxPackageFamily | undefined;
  readonly supported: boolean;
}

/** Download response kept independent of Node's global fetch implementation. */
export interface LinuxHopperDownload {
  readonly ok: boolean;
  readonly bytes: Uint8Array;
}

/** External effects required to install the official Linux package. */
export interface LinuxHopperInstallHost {
  distribution(): Promise<LinuxDistribution | undefined>;
  download(
    url: string,
    options: { readonly signal?: AbortSignal },
  ): Promise<LinuxHopperDownload>;
  createTemporaryDirectory(): Promise<string>;
  writeArchive(path: string, bytes: Uint8Array): Promise<void>;
  installPackage(family: LinuxPackageFamily, archive: string): Promise<boolean>;
  launcherReady(path: string): Promise<boolean>;
  cleanup(path: string): Promise<void>;
}

/** Structured outcome for every expected Linux installation failure. */
export type LinuxHopperInstallResult =
  | { readonly status: "installed"; readonly launcherPath: string }
  | {
      readonly status: "failed";
      readonly reason:
        | "unsupported_host"
        | "release_metadata"
        | "download"
        | "integrity"
        | "authorization_or_package_manager"
        | "launcher_missing"
        | "cancelled";
    };

/** Parse an os-release document without executing its shell syntax. */
export const parseLinuxDistribution = (text: string): LinuxDistribution => {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/u.exec(line.trim());
    if (match === null) continue;
    const key = match[1];
    const encoded = match[2];
    if (key === undefined || encoded === undefined) continue;
    const value =
      encoded.startsWith('"') && encoded.endsWith('"')
        ? encoded.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\")
        : encoded;
    fields.set(key, value);
  }
  const id = (fields.get("ID") ?? "unknown").toLowerCase();
  const versionId = fields.get("VERSION_ID");
  const packageFamily = packageFamilyFor(id, fields.get("ID_LIKE"));
  const supported =
    id === "arch" ||
    (id === "ubuntu" && versionAtLeast(versionId, 24)) ||
    (id === "fedora" && versionAtLeast(versionId, 41));
  return {
    id,
    ...(versionId === undefined ? {} : { versionId }),
    packageFamily,
    supported,
  };
};

/** Read and classify the current Linux distribution. */
export const readLinuxDistribution = async (): Promise<
  LinuxDistribution | undefined
> => {
  try {
    return parseLinuxDistribution(await readFile("/etc/os-release", "utf8"));
  } catch {
    return undefined;
  }
};

/** Download, verify, install, and read back the official Hopper Linux package. */
export const installLinuxHopper = async (
  host: LinuxHopperInstallHost = systemLinuxHopperInstallHost(),
  options: {
    readonly signal?: AbortSignal;
    readonly releases?: Readonly<
      Record<LinuxPackageFamily, LinuxHopperRelease>
    >;
  } = {},
): Promise<LinuxHopperInstallResult> => {
  if (options.signal?.aborted === true)
    return { status: "failed", reason: "cancelled" };
  const distribution = await host.distribution();
  if (
    distribution?.supported !== true ||
    distribution.packageFamily === undefined
  )
    return { status: "failed", reason: "unsupported_host" };
  let temporary: string | undefined;
  try {
    const release = (options.releases ?? SUPPORTED_RELEASES)[
      distribution.packageFamily
    ];
    const archiveDownload = await host.download(release.filename, options);
    if (!archiveDownload.ok) return { status: "failed", reason: "download" };
    if (!packageIntegrityMatches(archiveDownload.bytes, release))
      return { status: "failed", reason: "integrity" };
    temporary = await host.createTemporaryDirectory();
    const archive = join(temporary, `hopper.${distribution.packageFamily}`);
    await host.writeArchive(archive, archiveDownload.bytes);
    if (!(await host.installPackage(distribution.packageFamily, archive)))
      return { status: "failed", reason: "authorization_or_package_manager" };
    const launcherPath = "/opt/hopper/bin/Hopper";
    if (!(await host.launcherReady(launcherPath)))
      return { status: "failed", reason: "launcher_missing" };
    return { status: "installed", launcherPath };
  } catch (cause: unknown) {
    if (isAbortCause(cause)) return { status: "failed", reason: "cancelled" };
    return { status: "failed", reason: "download" };
  } finally {
    if (temporary !== undefined) await host.cleanup(temporary);
  }
};

/** Canonical launcher path for a legacy user-local Linux Hopper installation. */
export const linuxHopperLauncherPath = (home: string): string =>
  join(home, ".local/share/rea/hopper/bin/Hopper");

const systemLinuxHopperInstallHost = (): LinuxHopperInstallHost => ({
  distribution: readLinuxDistribution,
  async download(url, options) {
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "rea-installer" },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return {
      ok: response.ok,
      bytes: new Uint8Array(await response.arrayBuffer()),
    };
  },
  createTemporaryDirectory: () => mkdtemp(join(tmpdir(), "rea-hopper-")),
  writeArchive: (path, bytes) => writeFile(path, bytes, { mode: 0o600 }),
  installPackage: installSystemPackage,
  async launcherReady(path) {
    try {
      await access(path);
      const linked = await execFileAsync("ldd", [path]);
      return (
        linuxSharedLibrariesAvailable(`${linked.stdout}\n${linked.stderr}`) &&
        (await linuxHopperBinarySupported(path))
      );
    } catch {
      return false;
    }
  },
  cleanup: (path) => rm(path, { recursive: true, force: true }),
});

/** Match the Linux Hopper build validated by the packaged demo-dialog adapter. */
export const linuxHopperBinarySupported = async (
  path: string,
): Promise<boolean> => {
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex") === SUPPORTED_HOPPER_SHA256;
  } catch {
    return false;
  }
};

/** Interpret ldd output conservatively so a present but broken launcher is unhealthy. */
export const linuxSharedLibrariesAvailable = (output: string): boolean =>
  !/(?:=>\s+not found|error while loading shared libraries)/iu.test(output);

const installSystemPackage = async (
  family: LinuxPackageFamily,
  archive: string,
): Promise<boolean> => {
  try {
    for (const command of linuxPackageManagerCommands(
      family,
      archive,
      process.getuid?.() === 0,
    ))
      await execFileAsync(command.executable, command.args);
    return true;
  } catch {
    return false;
  }
};

/** Select the native package manager and authorization boundary without shell evaluation. */
export const linuxPackageManagerCommands = (
  family: LinuxPackageFamily,
  archive: string,
  isRoot: boolean,
): readonly {
  readonly executable: string;
  readonly args: readonly string[];
}[] => {
  const runtimeDependencies =
    family === "deb"
      ? ["xvfb", "xauth", "python3", "libx11-6", "libxtst6"]
      : family === "rpm"
        ? [
            "xorg-x11-server-Xvfb",
            "xorg-x11-xauth",
            "python3",
            "libX11",
            "libXtst",
          ]
        : ["xorg-server-xvfb", "xorg-xauth", "python", "libx11", "libxtst"];
  const commands =
    family === "deb"
      ? [["apt-get", "install", "-y", archive, ...runtimeDependencies]]
      : family === "rpm"
        ? [["dnf", "install", "-y", archive, ...runtimeDependencies]]
        : [
            ["pacman", "-S", "--needed", "--noconfirm", ...runtimeDependencies],
            ["pacman", "-U", "--noconfirm", archive],
          ];
  return commands.map((command) => {
    const executable = isRoot ? command[0] : "pkexec";
    if (executable === undefined) throw new Error("package command is empty");
    return { executable, args: isRoot ? command.slice(1) : command };
  });
};

const packageIntegrityMatches = (
  bytes: Uint8Array,
  release: LinuxHopperRelease,
): boolean =>
  bytes.byteLength === Number(release.file_length) &&
  bytes.byteLength <= MAX_PACKAGE_BYTES &&
  createHash("sha1").update(bytes).digest("hex") === release.file_hash;

const packageFamilyFor = (
  id: string,
  idLike: string | undefined,
): LinuxPackageFamily | undefined => {
  const identities = new Set([
    id,
    ...(idLike?.toLowerCase().split(/\s+/u) ?? []),
  ]);
  if (identities.has("ubuntu") || identities.has("debian")) return "deb";
  if (identities.has("fedora") || identities.has("rhel")) return "rpm";
  if (identities.has("arch")) return "arch";
  return undefined;
};

const versionAtLeast = (
  version: string | undefined,
  minimum: number,
): boolean =>
  version !== undefined &&
  Number.parseInt(version.split(".")[0] ?? "0", 10) >= minimum;
const isAbortCause = (cause: unknown): boolean =>
  cause instanceof Error && cause.name === "AbortError";
