import { describe, expect, it } from "vitest";

import type { DesktopApplicationCapture } from "./desktopCapture.js";
import {
  capturedHomePath,
  appModuleFile,
  className,
  environmentName,
  launchCommand,
  launchDocumentLimitation,
  launchDocumentNote,
  ownedPaths,
  renderAppClass,
  renderEnvToml,
  renderInstallScript,
  renderReadme,
  seedWording,
  type DesktopAppExportPlan,
} from "./appExport.js";
import type { LaunchDocument } from "./seedDocument.js";

const plan: DesktopAppExportPlan = {
  name: "mousepad",
  className: "Mousepad",
  title: "Mousepad",
  aptPackage: "mousepad",
  aptRelease: null,
  packageVersion: "0.6.1",
  libraryPackages: [],
  aptSources: [],
  architectures: ["amd64", "arm64"],
  packageFile: null,
  electron: false,
  command: ["mousepad"],
  opens: { kind: "empty" },
  windowClass: "Mousepad",
  paths: [".config/Mousepad", "Documents"],
  capturedHome: "/home/ada",
  seedCheckpoint: "baseline",
  syntheticSeed: false,
  seedFiles: ["Documents/todo.txt"],
  textSeeds: ["Documents/todo.txt"],
  unseededFiles: [],
  leftOutLocks: [],
  unownedFolders: [],
  runtimeSeeds: [],
  dconf: "",
  captureEvidenceId: "ev_1",
};

const notNumeric = (name: string) => !/^\d+$/u.test(name);

describe("names", () => {
  it("derives portable environment and class names", () => {
    expect(environmentName("org.xfce.mousepad", notNumeric)).toBe("mousepad");
    expect(environmentName("My App!", notNumeric)).toBe("my-app");
    expect(className("gnu-cash")).toBe("GnuCash");
    expect(className("7zip")).toBe("App7zip");
    expect(className("none")).toBe("NoneApp");
    expect(className("true")).toBe("TrueApp");
  });

  it("ends a shortened name without a hyphen and prefixes one the name check refuses", () => {
    expect(
      environmentName(`${"a".repeat(47)}-b`, notNumeric).endsWith("-"),
    ).toBe(false);
    expect(environmentName("org.example.2048", notNumeric)).toBe("app-2048");
  });

  it("keeps the class off the module's own names and the module off other modules", () => {
    expect(className("path")).toBe("PathApp");
    expect(className("data-part")).toBe("DataPartApp");
    expect(className("run-script")).toBe("RunScriptApp");
    expect(className("p-a-t-h-s")).toBe("PATHSApp");
    expect(appModuleFile("calendar")).toBe("calendar_app.py");
    expect(appModuleFile("gnu-cash")).toBe("gnu_cash_app.py");
  });
});

describe("ownedPaths", () => {
  it("uses state directories and document folders, collapsing nested ones", () => {
    expect(
      ownedPaths(
        [".config/app/settings.ini", ".config/app/sub/x"],
        ["Documents/a.txt", "Documents/notes/b.txt"],
        [".config/app"],
      ),
    ).toEqual([".config/app", "Documents"]);
  });

  it("owns a folder beside a state directory, differing only in letter case, in the file's spelling", () => {
    expect(
      ownedPaths(
        [".config/GIMP/2.10/sessionrc", ".Gimp/x"],
        [],
        [".config/gimp", ".gimp"],
      ),
    ).toEqual([".Gimp", ".config/GIMP"]);
    expect(
      ownedPaths([".config/GIMPshop/2.10/sessionrc"], [], [".config/gimp"]),
    ).toEqual([".config/GIMPshop/2.10"]);
  });

  it("owns a file directly in the home or a shared folder as itself", () => {
    expect(ownedPaths(["books.gnucash"], [], [])).toEqual(["books.gnucash"]);
    expect(
      ownedPaths([".config/katerc", ".local/share/kate/a"], [".cache/x"], []),
    ).toEqual([".cache/x", ".config/katerc", ".local/share/kate"]);
  });
});

describe("launchCommand", () => {
  it("starts in the captured working directory, respelling the home and home arguments under $HOME", () => {
    expect(launchCommand(["mousepad"], "/home/ada", "/home/ada")).toEqual([
      "sh",
      "-c",
      `cd "$HOME" 2>/dev/null; exec 'mousepad'`,
    ]);
    expect(
      launchCommand(
        ["mousepad", "/home/ada/Documents/it's.txt"],
        "/home/ada",
        "/home/ada",
      ),
    ).toEqual([
      "sh",
      "-c",
      `cd "$HOME" 2>/dev/null; exec 'mousepad' "$HOME"/'Documents/it'"'"'s.txt'`,
    ]);
  });

  it("respells the home itself and option values under it", () => {
    expect(
      launchCommand(
        ["notes", "/home/ada", "--config=/home/ada/.notes", "--x=/home/adam"],
        "/home/ada",
        "/",
      ),
    ).toEqual([
      "sh",
      "-c",
      `cd '/' 2>/dev/null; exec 'notes' "$HOME" '--config='"$HOME"/'.notes' '--x=/home/adam'`,
    ]);
  });

  it("never leaves the app in the framework's own folder, whatever its arguments", () => {
    expect(
      launchCommand(
        ["notes", "today.md"],
        "/home/ada",
        "/home/ada/project/docs",
      ),
    ).toEqual([
      "sh",
      "-c",
      `cd "$HOME"/'project/docs' 2>/dev/null; exec 'notes' 'today.md'`,
    ]);
    expect(
      launchCommand(["notes", "--wrap"], "/home/ada", "/home/ada/project"),
    ).toEqual([
      "sh",
      "-c",
      `cd "$HOME"/'project' 2>/dev/null; exec 'notes' '--wrap'`,
    ]);
    expect(launchCommand(["./app"], "/home/ada", "/opt/app")).toEqual([
      "sh",
      "-c",
      "cd '/opt/app' 2>/dev/null; exec './app'",
    ]);
  });
});

describe("renderers", () => {
  it("names the module, base computer and driver in env.toml", () => {
    expect(renderEnvToml(plan)).toBe(
      'type = "computer_app"\nmodule = "mousepad_app.py:Mousepad"\ncomputer = "ubuntu-24.04"\ndriver = "reference"\n',
    );
  });

  it("reads views in a thread so get does not block the server", () => {
    expect(renderAppClass(plan)).toContain(
      "views = await in_thread(_views, Path.home(), self.paths)",
    );
  });

  it("declares data hooks only when the app owns paths", () => {
    expect(renderAppClass(plan)).toContain("keep_initial(self.paths)");
    expect(renderAppClass({ ...plan, paths: [] })).not.toContain("@get_data");
  });

  it("loads captured dconf settings even without owned paths", () => {
    const module = renderAppClass({
      ...plan,
      paths: [],
      dconf: "[org/app]\nwrap=true\n",
    });
    expect(module).toContain("_load_dconf(Path.home())");
    expect(module).toContain(
      'packages=Packages(apt=["mousepad", "dconf-cli"])',
    );
    expect(module).not.toContain("@get_data");
    expect(renderAppClass(plan)).toContain(
      'packages=Packages(apt=["mousepad"])',
    );
    expect(renderReadme({ ...plan, dconf: "[org/app]\n" })).toContain(
      "dconf-cli",
    );
  });

  it("names only text seeds for home path respelling", () => {
    expect(
      renderAppClass({
        ...plan,
        seedFiles: ["a.db", "b.txt"],
        textSeeds: ["b.txt"],
      }),
    ).toContain('TEXT_SEEDS = frozenset(["b.txt"])');
  });

  it("declares a vendor repository with its key, the app from its release, the host's architecture, and library packages after the app's", () => {
    const typora: DesktopAppExportPlan = {
      ...plan,
      name: "typora",
      aptPackage: "typora",
      aptRelease: "stable",
      architectures: ["arm64"],
      libraryPackages: ["libgbm1", "libnss3"],
      aptSources: [
        {
          uri: "https://downloads.typora.io/linux",
          suite: "./",
          components: [],
          keyFile: "apt-keys/typora.gpg",
          keySha256: "a".repeat(64),
        },
      ],
      electron: true,
      dconf: "[org/app]\n",
    };

    const module = renderAppClass(typora);

    expect(module).toContain(
      'packages=Packages(apt=["typora/stable", "libgbm1", "libnss3", "dconf-cli"]),\n    sources=[AptSource(apt="https://downloads.typora.io/linux", suite="./", components=[], key="apt-keys/typora.gpg")],',
    );
    expect(module).toContain(
      '@computer_app(supports=[{"os": {"type": "linux", "display": ["x11"]}, "arch": ["arm64"]}])',
    );
    expect(renderAppClass(plan)).toContain('"arch": ["amd64", "arm64"]');
    expect(module).toContain(
      "from agentenv_protocol.computer import AptSource,",
    );
    const readme = renderReadme(typora);
    expect(readme).toContain(
      "for\n  `arm64`. It installs `typora/stable` from",
    );
    expect(readme).toContain(
      "from the apt repository `https://downloads.typora.io/linux` (suite `./`), trusting `apt-keys/typora.gpg`",
    );
    expect(readme).toContain("`libgbm1`, `libnss3`");
    expect(readme).toContain("Chromium's sandbox is off (`--no-sandbox`)");
    expect(renderReadme(plan)).toContain("from the distribution archive");
    expect(renderReadme(plan)).not.toContain("sandbox");
  });

  it("downloads a package file, installs it with its run script after its dependencies, and supports its architecture only", () => {
    const file = {
      url: "https://mirror.example.com/varicad/varicad2026-en_2.03_amd64.deb",
      sha256: "d".repeat(64),
      path: "vendor/varicad2026-en_2.03_amd64.deb",
      architecture: "amd64",
      dependencies: ["libc6", "libgl1", "dpkg"],
      unreadDependencies: [],
    };
    const varicad: DesktopAppExportPlan = {
      ...plan,
      name: "varicad",
      title: "VariCAD",
      aptPackage: "varicad2026-en",
      packageVersion: "2.03",
      architectures: ["amd64"],
      libraryPackages: ["libgl1", "libxt6t64"],
      packageFile: file,
    };

    const module = renderAppClass(varicad);

    expect(module).toContain(
      `@linux(
    packages=Packages(apt=["libc6", "libgl1", "dpkg", "libxt6t64"]),
    downloads=[Download(url="${file.url}", sha256="${file.sha256}", to="vendor/varicad2026-en_2.03_amd64.deb", arch="amd64")],
    run=[RunScript(script="install-package.sh")],
    launch=Launch(`,
    );
    expect(module).toContain(
      "Download, Launch, Packages, Ready, RunScript, computer_app, linux",
    );
    expect(module).toContain('"arch": ["amd64"]');
    expect(renderAppClass(plan)).not.toContain("downloads=");
    expect(renderInstallScript(file)).toBe(
      "#!/bin/sh\nset -eu\ndpkg -i 'vendor/varicad2026-en_2.03_amd64.deb'\nrm -f 'vendor/varicad2026-en_2.03_amd64.deb'\n",
    );
    expect(
      renderInstallScript({ ...file, path: "vendor/it's $HOME.deb" }),
    ).toContain(`dpkg -i 'vendor/it'"'"'s $HOME.deb'`);
    const readme = renderReadme(varicad);
    expect(readme).toContain(
      `It installs \`varicad2026-en\` 2.03 from its package file, downloaded from\n  \`${file.url}\` when the bundle is put and refused unless its SHA-256 is \`${file.sha256}\``,
    );
    expect(readme).toContain(
      "The bundle does not contain the package: `install-package.sh` installs `vendor/varicad2026-en_2.03_amd64.deb` with dpkg",
    );
    expect(readme).toContain("(`libc6`, `libgl1`, `dpkg`)");
    expect(readme).toContain(
      "runs exactly the captured version, on `amd64` only",
    );
    expect(readme).toContain("Vendor sites may refuse automated downloads");
    expect(readme).toContain(
      "such as a trial's terms, is the operator's to check",
    );
  });
});

describe("README and class wording", () => {
  it("adds one README line on what the launch opens: the seed's document, or why it opens none", () => {
    const command = launchCommand(
      ["mousepad", "/home/ada/Documents/todo.txt"],
      "/home/ada",
      "/home/ada",
    );
    const readme = (opens: LaunchDocument) =>
      renderReadme({ ...plan, command, opens });
    const bare = readme({ kind: "empty" });
    const seed = { kind: "seed", document: "Documents/todo.txt" } as const;
    const none = {
      kind: "none",
      reason: "the test gives this reason",
    } as const;

    expect(command.join(" ")).toContain(`"$HOME"/'Documents/todo.txt'`);
    expect(bare).toContain(`\`${command.join(" ")}\``);
    for (const opens of [seed, none]) {
      const note = launchDocumentNote({ opens });
      expect(note).not.toBe("");
      expect(readme(opens).replace(note, "")).toBe(bare);
    }
    expect(readme(seed)).toContain("`~/Documents/todo.txt`");
    expect(bare).not.toContain("~/Documents/todo.txt");
    const limitation = launchDocumentLimitation(none);
    expect(limitation).toContain(none.reason);
    expect(launchDocumentNote({ opens: none })).toContain(limitation);
    expect(readme({ kind: "captured" })).toBe(bare);
    for (const opens of [
      seed,
      { kind: "captured" },
      { kind: "empty" },
    ] as const)
      expect(launchDocumentLimitation(opens)).toBeUndefined();
  });

  it("says the seed is the user's own data to keep local, unless it was made for the task", () => {
    const own = { ...plan, seedCheckpoint: "drafted" };
    const made = { ...own, syntheticSeed: true };
    const wording = { own: seedWording(own), made: seedWording(made) };
    // The README's seed line and closing notice, and the class's docstring.
    const renderedIn = {
      origin: renderReadme,
      notice: renderReadme,
      docstring: renderAppClass,
    } satisfies Record<
      keyof typeof wording.own,
      (from: DesktopAppExportPlan) => string
    >;

    for (const [from, kept, other] of [
      [own, wording.own, wording.made],
      [made, wording.made, wording.own],
    ] as const)
      for (const key of ["origin", "notice", "docstring"] as const) {
        const rendered = renderedIn[key](from);
        expect(rendered).toContain(kept[key]);
        expect(rendered).not.toContain(other[key]);
      }
    for (const { origin, docstring } of [wording.own, wording.made]) {
      expect(origin).toContain("`drafted`");
      expect(docstring).toContain("drafted");
    }
    expect(renderReadme(made)).toContain("`envs/mousepad/seed/`");
    expect(renderReadme(own)).not.toContain("`envs/mousepad/seed/`");
  });
});

describe("capturedHomePath", () => {
  it("uses the selected spelling of a linked settings folder, and a database's logs", () => {
    const home = "/home/ada";
    const physical = `${home}/settings/vendor`;
    const database = `${home}/data/books.db`;
    const path = capturedHomePath({
      host: { home },
      application: { state_directories: [] },
      state: {
        selected_paths: [
          { path: `${home}/settings`, physical: `${home}/settings` },
          { path: `${home}/.config/vendor`, physical },
          { path: `${home}/Documents/linked.db`, physical: database },
        ],
      },
    } as unknown as DesktopApplicationCapture);

    expect(path(`${physical}/app.conf`)).toBe(".config/vendor/app.conf");
    expect(path(`${home}/Documents/note.txt`)).toBe("Documents/note.txt");
    expect(path(database)).toBe("Documents/linked.db");
    expect(path(`${database}-wal`)).toBe("Documents/linked.db-wal");
    expect(path(`${database}-journal`)).toBe("Documents/linked.db-journal");
  });

  it("maps a database selected through a link together with its write-ahead log", () => {
    const home = "/home/ada";
    const path = capturedHomePath({
      host: { home },
      application: { state_directories: [] },
      state: {
        selected_paths: [
          { path: `${home}/.config/app.db`, physical: `${home}/data/app.db` },
        ],
      },
    } as unknown as DesktopApplicationCapture);
    expect(path(`${home}/data/app.db`)).toBe(".config/app.db");
    expect(path(`${home}/data/app.db-wal`)).toBe(".config/app.db-wal");
    expect(path(`${home}/data/app.db-journal`)).toBe(".config/app.db-journal");
  });

  it("keeps a walked settings folder when a broader directory was also selected", () => {
    const home = "/home/ada";
    const path = capturedHomePath({
      host: { home },
      application: {
        state_directories: [{ path: `${home}/.config/notes` }],
      },
      state: {
        state_directories: [`${home}/settings/notes`],
        selected_paths: [
          { path: `${home}/settings`, physical: `${home}/settings` },
        ],
      },
    } as unknown as DesktopApplicationCapture);

    expect(path(`${home}/settings/notes/settings.ini`)).toBe(
      ".config/notes/settings.ini",
    );
    expect(path(`${home}/settings/other.txt`)).toBe("settings/other.txt");
  });

  it("does not treat a database log name as a directory of other files", () => {
    const home = "/home/ada";
    const path = capturedHomePath({
      host: { home },
      application: { state_directories: [] },
      state: {
        selected_paths: [
          { path: `${home}/settings`, physical: `${home}/settings` },
          {
            path: `${home}/.config/notes`,
            physical: `${home}/settings/notes`,
          },
        ],
      },
    } as unknown as DesktopApplicationCapture);

    expect(path(`${home}/settings/notes/settings.ini`)).toBe(
      ".config/notes/settings.ini",
    );
    expect(path(`${home}/settings/notes-journal/today.txt`)).toBe(
      "settings/notes-journal/today.txt",
    );
  });

  it("moves a walked state database's logs with the database", () => {
    const home = "/home/ada";
    const path = capturedHomePath({
      host: { home },
      application: {
        state_directories: [{ path: `${home}/.notes-state.db` }],
      },
      state: {
        state_directories: [`${home}/settings/notes.db`],
        selected_paths: [
          { path: `${home}/settings`, physical: `${home}/settings` },
        ],
      },
    } as unknown as DesktopApplicationCapture);

    expect(path(`${home}/settings/notes.db`)).toBe(".notes-state.db");
    expect(path(`${home}/settings/notes.db-wal`)).toBe(".notes-state.db-wal");
    expect(path(`${home}/settings/notes.db-journal`)).toBe(
      ".notes-state.db-journal",
    );
  });
});
