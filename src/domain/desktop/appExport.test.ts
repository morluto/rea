import { describe, expect, it } from "vitest";

import {
  appModuleFile,
  className,
  environmentName,
  launchCommand,
  ownedPaths,
  renderAppClass,
  renderEnvToml,
  renderReadme,
  type DesktopAppExportPlan,
} from "./appExport.js";

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
  electron: false,
  command: ["mousepad"],
  windowClass: "Mousepad",
  paths: [".config/Mousepad", "Documents"],
  capturedHome: "/home/ada",
  seedFiles: ["Documents/todo.txt"],
  textSeeds: ["Documents/todo.txt"],
  unseededFiles: [],
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
    expect(className("element-tree")).toBe("ElementTreeApp");
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

  it("owns a file directly in the home or a shared folder as itself", () => {
    expect(ownedPaths(["books.gnucash"], [], [])).toEqual(["books.gnucash"]);
    expect(
      ownedPaths([".config/katerc", ".local/share/kate/a"], [".cache/x"], []),
    ).toEqual([".cache/x", ".config/katerc", ".local/share/kate"]);
  });
});

describe("launchCommand", () => {
  it("keeps commands without home paths and respells home arguments under $HOME", () => {
    expect(launchCommand(["mousepad"], "/home/ada", "/home/ada")).toEqual([
      "mousepad",
    ]);
    expect(
      launchCommand(
        ["mousepad", "/home/ada/Documents/it's.txt"],
        "/home/ada",
        "/home/ada",
      ),
    ).toEqual(["sh", "-c", `exec 'mousepad' "$HOME"/'Documents/it'"'"'s.txt'`]);
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
      `exec 'notes' "$HOME" '--config='"$HOME"/'.notes' '--x=/home/adam'`,
    ]);
  });

  it("tries the captured working directory, the home included, only for relative arguments", () => {
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
      launchCommand(["notes", "today.md"], "/home/ada", "/home/ada"),
    ).toEqual(["sh", "-c", `cd "$HOME" 2>/dev/null; exec 'notes' 'today.md'`]);
    expect(
      launchCommand(["notes", "--wrap"], "/home/ada", "/home/ada/project"),
    ).toEqual(["notes", "--wrap"]);
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
});
