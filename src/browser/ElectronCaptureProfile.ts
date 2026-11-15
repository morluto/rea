import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Electron `app.getPath` names the active hook redirects before application code runs. */
export const ELECTRON_CAPTURE_PROFILE_PATHS = [
  "home",
  "appData",
  "temp",
  "logs",
  "crashDumps",
] as const;
type ElectronProfilePathName = (typeof ELECTRON_CAPTURE_PROFILE_PATHS)[number];

/** Environment handoff the active hook consumes before application code runs. */
export const ELECTRON_CAPTURE_PROFILE_VARIABLE = "REA_ELECTRON_CAPTURE_PROFILE";

/**
 * One capture's private Electron profile root.
 *
 * The provider owns the directory: it is created with owner-only permissions,
 * every Electron path and per-user environment location points inside it, and
 * only {@link ElectronCaptureProfile.remove} deletes it.
 */
export class ElectronCaptureProfile {
  private constructor(
    readonly root: string,
    readonly paths: Readonly<Record<ElectronProfilePathName, string>>,
  ) {}

  static async create(): Promise<ElectronCaptureProfile> {
    const root = await mkdtemp(join(tmpdir(), "rea-electron-profile-"));
    const profile = new ElectronCaptureProfile(
      root,
      Object.fromEntries(
        ELECTRON_CAPTURE_PROFILE_PATHS.map((name) => [name, join(root, name)]),
      ) as Record<ElectronProfilePathName, string>,
    );
    try {
      await chmod(root, 0o700);
      for (const path of Object.values(profile.paths))
        await mkdir(path, { recursive: true });
      await mkdir(profile.#localAppData, { recursive: true });
    } catch (cause: unknown) {
      await profile.remove();
      throw cause;
    }
    return profile;
  }

  get #localAppData(): string {
    return join(this.root, "localAppData");
  }

  /** Per-user locations Node, Electron and libraries derive from the environment. */
  environment(platform: NodeJS.Platform): Record<string, string> {
    const { home, temp, appData } = this.paths;
    return {
      HOME: home,
      TMPDIR: temp,
      TMP: temp,
      ...(platform === "win32"
        ? {
            TEMP: temp,
            USERPROFILE: home,
            APPDATA: appData,
            LOCALAPPDATA: this.#localAppData,
          }
        : {}),
      [ELECTRON_CAPTURE_PROFILE_VARIABLE]: JSON.stringify(this.paths),
    };
  }

  remove(): Promise<void> {
    return rm(this.root, { recursive: true, force: true, maxRetries: 3 });
  }
}
