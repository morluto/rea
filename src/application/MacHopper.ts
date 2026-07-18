import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

const execFileAsync = promisify(execFile);
const RELEASES_URL =
  "https://www.hopperapp.com/include/files-api.php?request=releases&public=true";
const DOWNLOAD_PREFIX = "https://www.hopperapp.com:443/downloader/public/";
const MAX_PACKAGE_BYTES = 100_000_000;
const BUNDLE_IDENTIFIER = "com.cryptic-apps.hopper-web-4";

/** Stable network and command effects disclosed before macOS Hopper setup. */
export const macHopperInstallDisclosure = {
  networkOrigins: [RELEASES_URL, DOWNLOAD_PREFIX] as const,
  commands: [
    "hdiutil attach -readonly -nobrowse -mountpoint <private-mount> <verified-hopper.dmg>",
    "codesign --verify --deep --strict <mounted-hopper.app>",
    "ditto <mounted-hopper.app> <user-Applications-stage>",
    "open <installed-hopper.app>",
  ] as const,
};

/** Result of installing the official Hopper macOS application. */
export type MacHopperInstallResult =
  | { readonly status: "installed"; readonly launcherPath: string }
  | {
      readonly status: "failed";
      readonly reason:
        | "release_metadata"
        | "download"
        | "integrity"
        | "mount"
        | "bundle"
        | "destination_exists"
        | "copy"
        | "launcher_missing";
    };

/** External effects used by the bounded macOS Hopper installer. */
export interface MacHopperInstallHost {
  download(
    url: string,
  ): Promise<{ readonly ok: boolean; readonly bytes: Uint8Array }>;
  createTemporaryDirectory(): Promise<string>;
  createMountDirectory(path: string): Promise<void>;
  writePackage(path: string, bytes: Uint8Array): Promise<void>;
  mount(packagePath: string, mountPath: string): Promise<boolean>;
  unmount(mountPath: string): Promise<void>;
  appBundle(mountPath: string): Promise<string | undefined>;
  validBundle(appPath: string): Promise<boolean>;
  destinationExists(path: string): Promise<boolean>;
  installBundle(
    source: string,
    destination: string,
    stage: string,
    replaceExisting: boolean,
  ): Promise<boolean>;
  launcherReady(path: string): Promise<boolean>;
  openApplication(path: string): Promise<void>;
  cleanup(path: string): Promise<void>;
  destination(): string;
}

/** Download, verify, and install Hopper into the current user's Applications directory. */
export const installMacHopper = async (
  options: { readonly replaceExisting?: boolean } = {},
  host: MacHopperInstallHost = systemMacHopperInstallHost(),
): Promise<MacHopperInstallResult> => {
  let temporary: string | undefined;
  let mounted = false;
  try {
    const metadata = await host.download(RELEASES_URL);
    if (!metadata.ok) return { status: "failed", reason: "release_metadata" };
    const parsed = releasesSchema.safeParse(parseJson(metadata.bytes));
    if (!parsed.success)
      return { status: "failed", reason: "release_metadata" };
    const release = parsed.data["OS X"];
    if (!release.filename.startsWith(DOWNLOAD_PREFIX))
      return { status: "failed", reason: "release_metadata" };
    const archive = await host.download(release.filename);
    if (!archive.ok) return { status: "failed", reason: "download" };
    if (!integrityMatches(archive.bytes, release))
      return { status: "failed", reason: "integrity" };

    const destination = host.destination();
    const destinationExists = await host.destinationExists(destination);
    if (destinationExists && options.replaceExisting !== true)
      return { status: "failed", reason: "destination_exists" };
    temporary = await host.createTemporaryDirectory();
    const packagePath = join(temporary, "hopper.dmg");
    const mountPath = join(temporary, "mounted");
    await host.createMountDirectory(mountPath);
    await host.writePackage(packagePath, archive.bytes);
    if (!(await host.mount(packagePath, mountPath)))
      return { status: "failed", reason: "mount" };
    mounted = true;
    const source = await host.appBundle(mountPath);
    if (source === undefined || !(await host.validBundle(source)))
      return { status: "failed", reason: "bundle" };
    const stage = `${destination}.rea-stage`;
    if (
      !(await host.installBundle(source, destination, stage, destinationExists))
    )
      return { status: "failed", reason: "copy" };
    const launcherPath = join(destination, "Contents/MacOS/hopper");
    if (!(await host.launcherReady(launcherPath)))
      return { status: "failed", reason: "launcher_missing" };
    await host.openApplication(destination);
    return { status: "installed", launcherPath };
  } catch {
    return { status: "failed", reason: "download" };
  } finally {
    if (temporary !== undefined) {
      const mountPath = join(temporary, "mounted");
      if (mounted) await host.unmount(mountPath);
      await host.cleanup(temporary);
    }
  }
};

const systemMacHopperInstallHost = (): MacHopperInstallHost => ({
  download: downloadPackage,
  createTemporaryDirectory: () => mkdtemp(join(tmpdir(), "rea-hopper-mac-")),
  createMountDirectory: (path) => mkdir(path),
  writePackage: (path, bytes) => writeFile(path, bytes, { mode: 0o600 }),
  async mount(packagePath, mountPath) {
    return commandSucceeds("hdiutil", [
      "attach",
      "-readonly",
      "-nobrowse",
      "-mountpoint",
      mountPath,
      packagePath,
    ]);
  },
  async unmount(mountPath) {
    await commandSucceeds("hdiutil", ["detach", mountPath, "-force"]);
  },
  async appBundle(mountPath) {
    const entries = await readdir(mountPath, { withFileTypes: true });
    const app = entries.find(
      (entry) => entry.isDirectory() && /^Hopper.*\.app$/iu.test(entry.name),
    );
    return app === undefined ? undefined : join(mountPath, app.name);
  },
  async validBundle(appPath) {
    if (
      !(await commandSucceeds("codesign", [
        "--verify",
        "--deep",
        "--strict",
        appPath,
      ]))
    )
      return false;
    try {
      const identifier = (
        await execFileAsync("/usr/libexec/PlistBuddy", [
          "-c",
          "Print :CFBundleIdentifier",
          join(appPath, "Contents/Info.plist"),
        ])
      ).stdout.trim();
      return identifier === BUNDLE_IDENTIFIER;
    } catch {
      return false;
    }
  },
  async destinationExists(path) {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
  async installBundle(source, destination, stage, replaceExisting) {
    const previous = `${stage}-previous`;
    try {
      await mkdir(join(homedir(), "Applications"), { recursive: true });
      await rm(stage, { recursive: true, force: true });
      await rm(previous, { recursive: true, force: true });
      await execFileAsync("ditto", [source, stage]);
      await access(join(stage, "Contents/MacOS/hopper"));
      if (replaceExisting) await rename(destination, previous);
      await rename(stage, destination);
      if (replaceExisting) await rm(previous, { recursive: true, force: true });
      return true;
    } catch {
      await rm(stage, { recursive: true, force: true });
      if (replaceExisting) {
        try {
          await rename(previous, destination);
        } catch {
          // The original destination was not moved, or rollback is impossible.
        }
      }
      return false;
    }
  },
  async launcherReady(path) {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
  async openApplication(path) {
    await execFileAsync("open", [path]);
  },
  cleanup: (path) => rm(path, { recursive: true, force: true }),
  destination: () => join(homedir(), "Applications/Hopper Disassembler.app"),
});

const downloadPackage = async (url: string) => {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "rea-installer" },
    signal: AbortSignal.timeout(120_000),
  });
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_PACKAGE_BYTES) return { ok: false, bytes: new Uint8Array() };
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { ok: response.ok && bytes.byteLength <= MAX_PACKAGE_BYTES, bytes };
};

const parseJson = (bytes: Uint8Array): unknown =>
  JSON.parse(new TextDecoder().decode(bytes));
const integrityMatches = (
  bytes: Uint8Array,
  release: z.infer<typeof releaseSchema>,
): boolean =>
  bytes.byteLength === Number(release.file_length) &&
  bytes.byteLength <= MAX_PACKAGE_BYTES &&
  createHash("sha1").update(bytes).digest("hex") === release.file_hash;
const commandSucceeds = async (
  command: string,
  args: readonly string[],
): Promise<boolean> => {
  try {
    await execFileAsync(command, args);
    return true;
  } catch {
    return false;
  }
};
const releaseSchema = z.object({
  filename: z.string().url(),
  file_length: z.string().regex(/^\d+$/u),
  file_hash: z.string().regex(/^[a-f0-9]{40}$/u),
});
const releasesSchema = z.object({ "OS X": releaseSchema });
