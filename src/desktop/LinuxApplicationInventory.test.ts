import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { inspectLinuxApplication } from "./LinuxApplicationInventory.js";

const fixture = async () => {
  const root = await createTestTempDirectory("desktop-inventory-");
  const home = join(root, "home");
  const bin = join(root, "bin");
  const share = join(root, "share");
  await mkdir(join(home, ".config/Notes"), { recursive: true });
  await mkdir(bin);
  await mkdir(join(share, "applications"), { recursive: true });
  await writeFile(join(bin, "notes-app"), "#!/bin/sh\nexit 0\n");
  await chmod(join(bin, "notes-app"), 0o755);
  await writeFile(
    join(share, "applications/org.example.notes.desktop"),
    [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Notes",
      "Exec=notes-app --new %F",
      "StartupWMClass=NotesWindow",
    ].join("\n"),
  );
  return {
    home,
    bin,
    environment: {
      PATH: `${bin}:/usr/bin:/bin`,
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_DATA_DIRS: share,
    },
  };
};

describe.skipIf(process.platform === "win32")("inspectLinuxApplication", () => {
  it("resolves a desktop entry id into a launch command and state directories", async () => {
    const { home, bin, environment } = await fixture();

    const inspected = await inspectLinuxApplication({
      desktopEntry: "org.example.notes",
      executable: undefined,
      arguments: ["/tmp/today.md"],
      environment,
      home,
      callerDirectory: home,
    });

    if (!inspected.ok) throw new Error(inspected.error.reason);
    const { inventory } = inspected.value;
    expect(inventory.argv).toEqual(["notes-app", "--new", "/tmp/today.md"]);
    expect(inventory.desktop_entry).toMatchObject({
      id: "org.example.notes",
      name: "Notes",
      startup_wm_class: "NotesWindow",
    });
    expect(inventory.executable).toEqual({
      path: join(bin, "notes-app"),
      resolved_path: expect.stringMatching(/notes-app$/u),
      electron_markers: [],
    });
    expect(inventory.package.kind).toBe("unknown");
    const existing = inventory.state_directories
      .filter((entry) => entry.exists_at_start)
      .map((entry) => entry.path);
    // Case-insensitive filesystems also report the lowercase variant.
    expect(existing).toContain(join(home, ".config/Notes"));
    expect(
      existing.every(
        (path) =>
          path.toLowerCase() === join(home, ".config/notes").toLowerCase(),
      ),
    ).toBe(true);
    expect(inventory.state_directories.map((entry) => entry.path)).toContain(
      join(home, ".config/notes-app"),
    );
  });

  it("resolves a relative executable from the caller's directory and runs it there", async () => {
    const { home, bin, environment } = await fixture();

    const inspected = await inspectLinuxApplication({
      desktopEntry: undefined,
      executable: "./notes-app",
      arguments: ["today.md"],
      environment,
      home,
      callerDirectory: bin,
    });

    if (!inspected.ok) throw new Error(inspected.error.reason);
    expect(inspected.value.inventory.argv).toEqual([
      join(bin, "notes-app"),
      "today.md",
    ]);
    expect(inspected.value.inventory.working_directory).toBe(bin);
  });

  it("refuses an unknown entry and an executable that is not on PATH", async () => {
    const { home, environment } = await fixture();
    const missingEntry = await inspectLinuxApplication({
      desktopEntry: "org.example.missing",
      executable: undefined,
      arguments: [],
      environment,
      home,
      callerDirectory: home,
    });
    expect(!missingEntry.ok && missingEntry.error.reason).toBe(
      "desktop_entry_not_found",
    );
    const missingProgram = await inspectLinuxApplication({
      desktopEntry: undefined,
      executable: "not-installed-anywhere",
      arguments: [],
      environment,
      home,
      callerDirectory: home,
    });
    expect(!missingProgram.ok && missingProgram.error).toEqual({
      reason: "executable_not_found",
      program: "not-installed-anywhere",
    });
  });
});
