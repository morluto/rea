import { describe, expect, it } from "vitest";

import type { DesktopApplicationCapture } from "../../domain/desktop/desktopCapture.js";
import type { DesktopApplicationState } from "../../domain/desktop/desktopState.js";
import { planLaunch } from "./DesktopExportLaunch.js";

const HOME = "/home/ada";
type StatePath = DesktopApplicationState["paths"][number];

const file = (physical: string, role: StatePath["role"]): StatePath =>
  ({ path: physical, role }) as StatePath;

describe("planLaunch captured paths", () => {
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
