import { describe, expect, it } from "vitest";

import { isApplicationDconfGroup, stateRole } from "./stateRoles.js";

describe("stateRole", () => {
  it("ranks application evidence above documents and shared desktop files", () => {
    expect(stateRole(["state_directory"])).toBe("application_state");
    expect(stateRole(["dconf_application_keys", "desktop_service"])).toBe(
      "application_state",
    );
    expect(stateRole(["state_directory", "desktop_service"])).toBe(
      "shared_desktop",
    );
    expect(stateRole(["named_in_window_title"])).toBe("document");
    expect(stateRole(["desktop_service"])).toBe("shared_desktop");
    expect(stateRole([])).toBe("unrelated");
  });
});

describe("isApplicationDconfGroup", () => {
  it("matches a whole path segment, not a substring", () => {
    const names = new Set(["mousepad"]);
    expect(isApplicationDconfGroup("org/xfce/mousepad/state", names)).toBe(
      true,
    );
    expect(
      isApplicationDconfGroup("org/gtk/settings/file-chooser", names),
    ).toBe(false);
    expect(isApplicationDconfGroup("org/mousepadx", names)).toBe(false);
  });
});
