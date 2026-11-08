import { describe, expect, it } from "vitest";

import type { DesktopApplicationCapture } from "../../domain/desktop/desktopCapture.js";
import type { DesktopApplicationState } from "../../domain/desktop/desktopState.js";
import { planLaunch } from "./DesktopExportLaunch.js";

const HOME = "/home/ada";
type StatePath = DesktopApplicationState["paths"][number];

const file = (physical: string, role: StatePath["role"]): StatePath =>
  ({ path: physical, role }) as StatePath;

describe("planLaunch captured paths", () => {
  it.each([
    ["/mnt/data/books.db", "/mnt/data/books.db"],
    ["file:///mnt/data/books.db?mode=edit#page", "/mnt/data/books.db"],
  ])("retargets selected outside-home argument %s", (argument, physical) => {
    const capture = {
      host: { home: HOME },
      application: {
        argv: ["editor", argument],
        working_directory: HOME,
        desktop_entry: { exec: "editor %U" },
        state_directories: [],
      },
      state: {
        state_directories: [],
        selected_paths: [
          { path: `${HOME}/Documents/books.db`, physical, kind: "file" },
        ],
      },
    } as unknown as DesktopApplicationCapture;
    const files = new Map([["Documents/books.db", file(physical, "document")]]);
    const seeds = new Map([
      ["Documents/books.db", { sha256: "a".repeat(64), format: "text" }],
    ]);
    const launch = planLaunch(capture, false, seeds, files);
    expect(launch.opens).toEqual({ kind: "captured" });
    expect(launch.command.join(" ")).toContain("Documents/books.db");
    expect(launch.command.join(" ")).not.toContain("/mnt/data/books.db");
    if (argument.startsWith("file:"))
      expect(launch.command.join(" ")).toContain("?mode=edit#page");
  });

  it("leaves an unrelated outside-home argument untouched", () => {
    const capture = {
      host: { home: HOME },
      application: {
        argv: ["editor", "/mnt/other/unselected.db"],
        working_directory: HOME,
        desktop_entry: { exec: "editor %U" },
        state_directories: [],
      },
      state: {
        state_directories: [],
        selected_paths: [
          {
            path: `${HOME}/Documents/books.db`,
            physical: "/mnt/data/books.db",
            kind: "file",
          },
        ],
      },
    } as unknown as DesktopApplicationCapture;
    const files = new Map([
      ["Documents/books.db", file("/mnt/data/books.db", "document")],
    ]);
    const command = planLaunch(capture, false, new Map(), files).command.join(
      " ",
    );
    expect(command).toContain("/mnt/other/unselected.db");
  });

  it("keeps an encoded filename when a file URL has repeated separators", () => {
    const physical = `${HOME}/data/A budget.svg`;
    const capture = {
      host: { home: HOME },
      application: {
        argv: [
          "editor",
          `file://localhost${HOME}//data//%41%20budget.svg?mode=edit#page`,
        ],
        working_directory: HOME,
        desktop_entry: { exec: "editor %U" },
        state_directories: [],
      },
      state: {
        state_directories: [],
        selected_paths: [{ path: `${HOME}/Documents/A budget.svg`, physical }],
      },
    } as unknown as DesktopApplicationCapture;
    const files = new Map([
      ["Documents/A budget.svg", file(physical, "document")],
    ]);
    const command = planLaunch(capture, false, new Map(), files).command.join(
      " ",
    );
    expect(command).toContain("/Documents/%41%20budget.svg?mode=edit#page");
  });

  it("opens the selected document spelling when its captured file URL names the physical path", () => {
    const physical = `${HOME}/data/A budget.svg`;
    const capture = {
      host: { home: HOME },
      application: {
        argv: [
          "editor",
          `file://localhost${HOME}/data/%41%20budget.svg?mode=edit#page`,
        ],
        working_directory: HOME,
        desktop_entry: { exec: "editor %U" },
        state_directories: [],
      },
      state: {
        state_directories: [],
        selected_paths: [{ path: `${HOME}/Documents/A budget.svg`, physical }],
      },
    } as unknown as DesktopApplicationCapture;
    const files = new Map([
      ["Documents/A budget.svg", file(physical, "document")],
    ]);
    const command = planLaunch(capture, false, new Map(), files).command.join(
      " ",
    );
    expect(command).toContain("file://localhost");
    expect(command).toContain("/Documents/%41%20budget.svg?mode=edit#page");
    expect(command).not.toContain("/data/%41%20budget.svg");
  });

  it("rewrites a nested settings folder and leaves a numeric option", () => {
    const profile = `${HOME}/settings/geany/profiles/work/geany.conf`;
    const files = new Map<string, StatePath>([
      [
        ".config/geany/profiles/work/geany.conf",
        file(profile, "application_state"),
      ],
      [
        "Documents/poster.svg",
        file(`${HOME}/Documents/poster.svg`, "document"),
      ],
    ]);
    const capture = {
      host: { home: HOME },
      application: {
        argv: ["geany", "--config=settings/geany/profiles/work", "--line=10"],
        working_directory: HOME,
        desktop_entry: { exec: "geany" },
        state_directories: [{ path: `${HOME}/.config/geany` }],
      },
      state: {
        state_directories: [`${HOME}/settings/geany`],
        selected_paths: [
          {
            path: `${HOME}/.config/geany`,
            physical: `${HOME}/settings/geany`,
          },
        ],
      },
    } as unknown as DesktopApplicationCapture;

    const command = planLaunch(capture, false, new Map(), files).command.join(
      " ",
    );

    expect(command).toContain(`"$HOME"/'.config/geany/profiles/work'`);
    expect(command).toContain("'--line=10'");
    expect(command).not.toContain("settings/geany");
  });

  it("keeps the program an env prefix runs when a captured file sits in a folder of that name", () => {
    const config = `${HOME}/work/geany/config.ini`;
    const files = new Map<string, StatePath>([
      [".config/vendor/geany/config.ini", file(config, "application_state")],
    ]);
    const capture = {
      host: { home: HOME },
      application: {
        argv: ["env", "GDK_BACKEND=x11", "geany", "note.txt"],
        working_directory: `${HOME}/work`,
        desktop_entry: { exec: "geany %f" },
        state_directories: [{ path: `${HOME}/.config/vendor` }],
      },
      state: {
        state_directories: [`${HOME}/work`],
        selected_paths: [
          { path: `${HOME}/.config/vendor`, physical: `${HOME}/work` },
        ],
      },
    } as unknown as DesktopApplicationCapture;
    const note = file(`${HOME}/work/note.txt`, "document");
    files.set("work/note.txt", note);

    const command = planLaunch(
      capture,
      false,
      new Map([["work/note.txt", { sha256: "a".repeat(64), format: "text" }]]),
      files,
    ).command.join(" ");

    expect(command).toContain("'GDK_BACKEND=x11'");
    expect(command).toContain("'geany'");
    expect(command).toContain(`"$HOME"/'.config/vendor/note.txt'`);
    expect(command).not.toContain(".config/vendor/geany");
  });
});
