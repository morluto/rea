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
});
