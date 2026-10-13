import { basename, dirname, join, sep } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CLAUDE_DESKTOP_PACKAGE_FAMILY,
  resolveWindowsClaudeDesktopLocation,
  type ClaudeDesktopLocationFileSystem,
} from "./ClaudeDesktopConfigLocation.js";
import {
  packagePrivateLauncherBlocker,
  packagePrivateStorageFamily,
  redirectedWriteBlocker,
  type MsixPackageView,
} from "./MsixPackageStorage.js";

const home = join("/profile", "a");
const env = {
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
};
const packages = join(env.LOCALAPPDATA, "Packages");
const appDataConfig = join(env.APPDATA, "Claude", "claude_desktop_config.json");
const privateConfig = join(
  packages,
  CLAUDE_DESKTOP_PACKAGE_FAMILY,
  "LocalCache",
  "Roaming",
  "Claude",
  "claude_desktop_config.json",
);

const failure = (code: string): Error =>
  Object.assign(new Error(`${code}: injected`), { code });

const file = { isFile: () => true };
const privateDirectory = dirname(privateConfig);
const privatePreferences = join(privateDirectory, "Preferences");
const appDataDirectory = dirname(appDataConfig);

/** Package storage holding `privateFiles`; realpath decides the process view. */
const packagedFileSystem = (
  realpath: ClaudeDesktopLocationFileSystem["realpath"],
  privateFiles: readonly string[] = [privateConfig],
): ClaudeDesktopLocationFileSystem => ({
  readdir: (path) => {
    if (path === packages) return [CLAUDE_DESKTOP_PACKAGE_FAMILY];
    if (path === privateDirectory)
      return privateFiles.map((name) => basename(name));
    throw failure("ENOENT");
  },
  lstat: (path) => {
    if (!privateFiles.includes(path)) throw failure("ENOENT");
    return file;
  },
  realpath,
});

describe("Claude Desktop MSIX process view", () => {
  it("recognizes a process that sees the private copy at the AppData path", () => {
    const location = resolveWindowsClaudeDesktopLocation(
      home,
      env,
      packagedFileSystem((path) =>
        path === appDataConfig ? privateConfig : path,
      ),
    );
    expect(location).toEqual({
      ok: true,
      value: expect.objectContaining({
        configPath: privateConfig,
        msixPackage: expect.objectContaining({ processView: "redirected" }),
      }),
    });
  });

  it("treats an absent AppData file as an unredirected process", () => {
    const location = resolveWindowsClaudeDesktopLocation(
      home,
      env,
      packagedFileSystem((path) => {
        if (path === appDataConfig) throw failure("ENOENT");
        return path;
      }),
    );
    expect(location.ok && location.value.msixPackage?.processView).toBe(
      "direct",
    );
  });

  it("recognizes redirection through another private file before the configuration exists", () => {
    const location = resolveWindowsClaudeDesktopLocation(
      home,
      env,
      packagedFileSystem(
        (path) =>
          path === join(appDataDirectory, "Preferences")
            ? privatePreferences
            : path,
        [privatePreferences],
      ),
    );
    expect(location.ok && location.value.configPath).toBe(privateConfig);
    expect(location.ok && location.value.msixPackage?.processView).toBe(
      "redirected",
    );
  });

  it("continues after a listed private file disappears", () => {
    const fs = packagedFileSystem(
      (path) =>
        path === join(appDataDirectory, "Preferences")
          ? privatePreferences
          : path,
      [privatePreferences],
    );
    const location = resolveWindowsClaudeDesktopLocation(home, env, {
      ...fs,
      readdir: (path) =>
        path === privateDirectory
          ? ["vanished", "Preferences"]
          : fs.readdir(path),
    });
    expect(location.ok && location.value.msixPackage?.processView).toBe(
      "redirected",
    );
  });

  it("keeps the view unknown when the package has no private files", () => {
    const location = resolveWindowsClaudeDesktopLocation(
      home,
      env,
      packagedFileSystem((path) => path, []),
    );
    expect(location.ok && location.value.msixPackage?.processView).toBe(
      "unknown",
    );
  });

  it("keeps the view unknown when the AppData path cannot be resolved", () => {
    const location = resolveWindowsClaudeDesktopLocation(
      home,
      env,
      packagedFileSystem((path) => {
        if (path === appDataConfig) throw failure("EACCES");
        return path;
      }),
    );
    expect(location.ok && location.value.msixPackage?.processView).toBe(
      "unknown",
    );
  });
});

describe("unresolved Claude Desktop package identity", () => {
  it("reports unreadable package storage instead of assuming AppData", () => {
    const location = resolveWindowsClaudeDesktopLocation(home, env, {
      readdir: () => {
        throw failure("EACCES");
      },
      lstat: () => file,
      realpath: (path) => path,
    });
    expect(location).toEqual({
      ok: false,
      error: {
        path: packages,
        message: expect.stringContaining("could not be inspected"),
      },
    });
  });

  it("reports an uninspectable private copy instead of choosing a file", () => {
    const location = resolveWindowsClaudeDesktopLocation(home, env, {
      readdir: () => [CLAUDE_DESKTOP_PACKAGE_FAMILY],
      lstat: () => {
        throw failure("EPERM");
      },
      realpath: (path) => path,
    });
    expect(location.ok).toBe(false);
    expect(!location.ok && location.error.path).toBe(privateConfig);
  });

  it("matches the package family case-insensitively, as Windows does", () => {
    const location = resolveWindowsClaudeDesktopLocation(home, env, {
      readdir: () => [CLAUDE_DESKTOP_PACKAGE_FAMILY.toUpperCase()],
      lstat: () => {
        throw failure("ENOENT");
      },
      realpath: (path) => path,
    });
    expect(location.ok && location.value.msixPackage?.packageFamilyName).toBe(
      CLAUDE_DESKTOP_PACKAGE_FAMILY.toUpperCase(),
    );
  });
});

describe("package-private REA launchers", () => {
  const launcher = join(
    env.APPDATA,
    "npm",
    "node_modules",
    "rea-agents",
    "scripts",
    "rea.mjs",
  );
  const stored = join(
    packages,
    CLAUDE_DESKTOP_PACKAGE_FAMILY,
    "LocalCache",
    "Roaming",
    "npm",
    "node_modules",
    "rea-agents",
    "scripts",
    "rea.mjs",
  );

  it("names the package that privately stores a path", () => {
    expect(packagePrivateStorageFamily(stored, packages)).toBe(
      CLAUDE_DESKTOP_PACKAGE_FAMILY,
    );
    expect(packagePrivateStorageFamily(launcher, packages)).toBeUndefined();
    expect(
      packagePrivateStorageFamily(
        join(packages, CLAUDE_DESKTOP_PACKAGE_FAMILY, "LocalState", "x"),
        packages,
      ),
    ).toBeUndefined();
  });

  it("blocks a launcher that only the package's processes can see", () => {
    const blocker = packagePrivateLauncherBlocker(
      [join("/Program Files", "nodejs", "node.exe"), launcher, "mcp"],
      packages,
      (path) => (path === launcher ? stored : path),
    );
    expect(blocker).toContain(stored);
    expect(blocker).toContain(CLAUDE_DESKTOP_PACKAGE_FAMILY);
    expect(blocker).toContain("npm install -g rea-agents");
  });

  it("compares the launcher with the canonical package storage path", () => {
    const shortProfilePackages = join(
      "/profile",
      "A~1",
      "AppData",
      "Local",
      "Packages",
    );
    const blocker = packagePrivateLauncherBlocker(
      [launcher, "mcp"],
      shortProfilePackages,
      (path) =>
        path === shortProfilePackages
          ? packages
          : path === launcher
            ? stored
            : path,
    );
    expect(blocker).toContain(CLAUDE_DESKTOP_PACKAGE_FAMILY);
  });

  it("allows ordinary and unresolvable launchers", () => {
    expect(
      packagePrivateLauncherBlocker(
        ["cmd.exe", "/d", "/c", "npx", "-y", "rea-agents@6.4.0", "mcp"],
        packages,
        () => {
          throw new Error("package runners are not resolved");
        },
      ),
    ).toBeUndefined();
    expect(
      packagePrivateLauncherBlocker([launcher, "mcp"], packages, () => {
        throw failure("ENOENT");
      }),
    ).toBeUndefined();
  });
});

describe("writes from a redirected AppData view", () => {
  const view: MsixPackageView = {
    packageFamilyName: CLAUDE_DESKTOP_PACKAGE_FAMILY,
    privateConfigPath: privateConfig,
    appDataConfigPath: appDataConfig,
    virtualizedRoots: [env.APPDATA, env.LOCALAPPDATA],
    processView: "redirected",
  };
  const vscode = join(env.APPDATA, "Code", "User", "mcp.json");
  const hermes = join(env.LOCALAPPDATA, "hermes", "config.yaml");
  const codex = join(home, ".codex", "config.toml");

  it("refuses only targets under the package's virtualized roots", () => {
    const blocker = redirectedWriteBlocker(
      view,
      [vscode, codex, hermes],
      "setup",
    );
    expect(blocker).toContain(`${vscode}, ${hermes}`);
    expect(blocker).not.toContain(codex);
    expect(blocker).toContain("Rerun setup from a terminal");
    expect(redirectedWriteBlocker(view, [codex], "setup")).toBeUndefined();
  });

  it("compares aliases through the existing parent of a new destination", () => {
    const alias = join(home, "skill-alias");
    const target = join(alias, "skills", "reverse-engineer-anything");
    const blocker = redirectedWriteBlocker(
      view,
      [target],
      "uninstall",
      (path) => {
        if (path === alias) return join(env.APPDATA, "dsh");
        if (path.startsWith(`${alias}${sep}`)) throw failure("ENOENT");
        return path;
      },
    );
    expect(blocker).toContain(target);
    expect(blocker).toContain("Rerun uninstall");
  });

  it("keeps canonicalization failures visible instead of assuming a target is outside AppData", () => {
    expect(
      redirectedWriteBlocker(view, [codex], "setup", () => {
        throw failure("EACCES");
      }),
    ).toContain("Cannot establish the MSIX write location");
  });

  it("allows every target without positive evidence of redirection", () => {
    for (const processView of ["direct", "unknown"] as const)
      expect(
        redirectedWriteBlocker({ ...view, processView }, [vscode], "uninstall"),
      ).toBeUndefined();
    expect(
      redirectedWriteBlocker(undefined, [vscode], "setup"),
    ).toBeUndefined();
  });
});
