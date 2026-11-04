import { describe, expect, it } from "vitest";

import {
  className,
  environmentName,
  launchCommand,
  ownedPaths,
  renderAppClass,
  renderEnvToml,
  type DesktopAppExportPlan,
} from "./appExport.js";

const plan: DesktopAppExportPlan = {
  name: "mousepad",
  className: "Mousepad",
  title: "Mousepad",
  aptPackage: "mousepad",
  packageVersion: "0.6.1",
  command: ["mousepad"],
  windowClass: "Mousepad",
  paths: [".config/Mousepad", "Documents"],
  capturedHome: "/home/ada",
  seedFiles: ["Documents/todo.txt"],
  dconf: "",
  captureEvidenceId: "ev_1",
};

describe("names", () => {
  it("derives portable environment and class names", () => {
    expect(environmentName("org.xfce.mousepad")).toBe("mousepad");
    expect(environmentName("My App!")).toBe("my-app");
    expect(className("gnu-cash")).toBe("GnuCash");
    expect(className("7zip")).toBe("App7zip");
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
});

describe("launchCommand", () => {
  it("keeps commands without home paths and respells home arguments under $HOME", () => {
    expect(launchCommand(["mousepad"], "/home/ada")).toEqual(["mousepad"]);
    expect(
      launchCommand(["mousepad", "/home/ada/Documents/it's.txt"], "/home/ada"),
    ).toEqual(["sh", "-c", `exec 'mousepad' "$HOME"/'Documents/it'"'"'s.txt'`]);
  });
});

describe("renderers", () => {
  it("names the module, base computer and driver in env.toml", () => {
    expect(renderEnvToml(plan)).toBe(
      'type = "computer_app"\nmodule = "mousepad.py:Mousepad"\ncomputer = "ubuntu-24.04"\ndriver = "reference"\n',
    );
  });

  it("declares data hooks only when the app owns paths", () => {
    expect(renderAppClass(plan)).toContain("keep_initial(self.paths)");
    expect(renderAppClass({ ...plan, paths: [] })).not.toContain("@get_data");
  });
});
