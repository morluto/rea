import {
  chmod,
  mkdir,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { inspectLinuxApplication } from "./LinuxApplicationInventory.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { ArtifactFileCleanupFailure } from "../artifacts/ArtifactFileOperation.js";
import { desktopOperationFailure } from "../application/desktop/DesktopCaptureRefusals.js";

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

describe.skipIf(process.platform === "win32")(
  "explicit executable traversal",
  () => {
    it("refuses a directory symlink as an executable while accepting a file symlink", async () => {
      const { home, bin, environment } = await fixture();
      const directoryAlias = join(bin, "directory-alias");
      const fileAlias = join(bin, "file-alias");
      await symlink(home, directoryAlias);
      await symlink(join(bin, "notes-app"), fileAlias);
      const inspect = (executable: string) =>
        inspectLinuxApplication({
          desktopEntry: undefined,
          executable,
          arguments: [],
          environment,
          home,
          callerDirectory: home,
        });
      expect(await inspect(fileAlias)).toMatchObject({ ok: true });
      expect(await inspect(directoryAlias)).toEqual({
        ok: false,
        error: { reason: "executable_not_found", program: directoryAlias },
      });
    });

    it("preserves symlink and parent traversal for the selected executable", async () => {
      const { home, environment } = await fixture();
      const physical = join(home, "physical");
      const named = join(home, "named");
      await mkdir(join(physical, "child"), { recursive: true });
      await mkdir(named);
      await symlink(join(physical, "child"), join(named, "link"));
      await writeFile(join(physical, "app"), "#!/bin/sh\n", { mode: 0o755 });
      await writeFile(join(named, "app"), "#!/bin/sh\n", { mode: 0o755 });
      const selected = `${named}/link/../app`;
      const result = await inspectLinuxApplication({
        desktopEntry: undefined,
        executable: selected,
        arguments: [],
        environment,
        home,
        callerDirectory: home,
      });
      if (!result.ok) throw new Error(result.error.reason);
      expect(result.value.inventory.argv[0]).toBe(selected);
      expect(result.value.inventory.executable.resolved_path).toBe(
        await realpath(join(physical, "app")),
      );
    });
  },
);

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

  it("finds a desktop entry installed as a link to the file", async () => {
    const { home, environment } = await fixture();
    const exports = join(home, ".local/share/flatpak/exports/share");
    await mkdir(join(exports, "applications"), { recursive: true });
    await writeFile(
      join(exports, "applications/org.example.linked.desktop"),
      "[Desktop Entry]\nType=Application\nName=Linked\nExec=notes-app\n",
    );
    await mkdir(join(home, ".local/share/applications"), { recursive: true });
    await symlink(
      join(exports, "applications/org.example.linked.desktop"),
      join(home, ".local/share/applications/org.example.linked.desktop"),
    );

    const inspected = await inspectLinuxApplication({
      desktopEntry: "org.example.linked",
      executable: undefined,
      arguments: [],
      environment,
      home,
      callerDirectory: home,
    });

    if (!inspected.ok) throw new Error(inspected.error.reason);
    expect(inspected.value.inventory.desktop_entry).toMatchObject({
      id: "org.example.linked",
      name: "Linked",
    });
  });

  it("names a flatpak's state after its application id, not the flatpak launcher", async () => {
    const { home, bin, environment } = await fixture();
    await writeFile(join(bin, "flatpak"), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, "flatpak"), 0o755);
    await mkdir(join(home, ".local/share/applications"), { recursive: true });
    await writeFile(
      join(home, ".local/share/applications/org.example.Notes.desktop"),
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Notes",
        "Exec=flatpak run --branch=stable --command=notes org.example.Notes @@u %U @@",
      ].join("\n"),
    );

    const inspected = await inspectLinuxApplication({
      desktopEntry: "org.example.Notes",
      executable: undefined,
      arguments: [],
      environment,
      home,
      callerDirectory: home,
    });

    if (!inspected.ok) throw new Error(inspected.error.reason);
    const { inventory } = inspected.value;
    expect(inventory.package).toMatchObject({
      kind: "flatpak",
      name: "org.example.Notes",
    });
    const paths = inventory.state_directories.map((entry) => entry.path);
    expect(paths).toContain(join(home, ".var/app/org.example.Notes"));
    expect(paths).toContain(join(home, ".config/org.example.Notes"));
    expect(paths.filter((path) => /flatpak/iu.test(path))).toEqual([]);
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

describe.skipIf(process.platform === "win32")(
  "inspectLinuxApplication desktop file ids",
  () => {
    it("resolves a nested entry by its desktop file id before a lower-priority flat one", async () => {
      const { home, environment } = await fixture();
      const share = environment.XDG_DATA_DIRS;
      await mkdir(join(home, ".local/share/applications/vendor"), {
        recursive: true,
      });
      await writeFile(
        join(
          home,
          ".local/share/applications/vendor/org.example.nested.desktop",
        ),
        "[Desktop Entry]\nType=Application\nName=High\nExec=notes-app --high\n",
      );
      // The spec's id for the nested entry above, installed at lower priority.
      await writeFile(
        join(share, "applications/vendor-org.example.nested.desktop"),
        "[Desktop Entry]\nType=Application\nName=Low\nExec=notes-app --low\n",
      );

      const inventory = await inventoryOf("vendor-org.example.nested", {
        home,
        environment,
      });

      expect(inventory.desktop_entry).toMatchObject({
        id: "vendor-org.example.nested",
        name: "High",
      });
      expect(inventory.argv).toEqual(["notes-app", "--high"]);
    });

    it("resolves an id whose directory name itself contains a dash", async () => {
      const { home, environment } = await fixture();
      const directory = join(home, ".local/share/applications/org.example");
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "my-app.desktop"),
        "[Desktop Entry]\nType=Application\nName=Dashed\nExec=notes-app\n",
      );

      const inventory = await inventoryOf("org.example-my-app", {
        home,
        environment,
      });

      expect(inventory.desktop_entry).toMatchObject({
        id: "org.example-my-app",
        name: "Dashed",
      });
    });

    it("refuses a lower-priority entry when an applicable path cannot be probed", async () => {
      const { home, environment } = await fixture();
      const share = environment.XDG_DATA_DIRS;
      const applications = join(home, ".local/share/applications");
      const vendor = join(applications, "vendor");
      await mkdir(vendor, { recursive: true });
      await writeFile(
        join(vendor, "org.example.app.desktop"),
        "[Desktop Entry]\nType=Application\nName=High\nExec=notes-app --high\n",
      );
      await writeFile(
        join(share, "applications/vendor-org.example.app.desktop"),
        "[Desktop Entry]\nType=Application\nName=Low\nExec=notes-app --low\n",
      );
      // The exact higher-priority path cannot be examined without directory
      // traversal permission; it must remain unknown rather than absent.
      await chmod(vendor, 0o000);

      try {
        const inspected = await inspectLinuxApplication({
          desktopEntry: "vendor-org.example.app",
          executable: undefined,
          arguments: [],
          environment,
          home,
          callerDirectory: home,
        });

        // Root ignores the mode bits, so the directory stays listable and the
        // scenario this asserts cannot be built.
        if (inspected.ok) expect(process.getuid?.()).toBe(0);
        else
          expect(inspected.error.reason).toBe(
            "desktop_entry_search_incomplete",
          );
      } finally {
        await chmod(vendor, 0o755);
      }
    });
  },
);

describe.skipIf(process.platform === "win32")(
  "unresolved desktop entry link targets",
  () => {
    it
      .skipIf(process.getuid?.() === 0)
      .each(["directory", "flat-file", "nested-file"] as const)(
      "refuses a lower-priority entry when a %s link target cannot be examined",
      async (kind) => {
        const { home, environment } = await fixture();
        const applications = join(home, ".local/share/applications");
        const blocked = join(home, "blocked");
        const target = join(blocked, "vendor");
        await mkdir(target, { recursive: true });
        await mkdir(applications, { recursive: true });
        await writeFile(
          join(target, "app.desktop"),
          "[Desktop Entry]\nType=Application\nName=High\nExec=notes-app\n",
        );
        await writeFile(
          join(environment.XDG_DATA_DIRS, "applications/vendor-app.desktop"),
          "[Desktop Entry]\nType=Application\nName=Low\nExec=notes-app\n",
        );
        let link: string;
        if (kind === "directory") {
          link = join(applications, "vendor");
          await symlink(target, link);
        } else {
          if (kind === "nested-file") await mkdir(join(applications, "vendor"));
          link = join(
            applications,
            kind === "flat-file" ? "vendor-app.desktop" : "vendor/app.desktop",
          );
          await symlink(join(target, "app.desktop"), link);
        }
        await chmod(blocked, 0o000);
        try {
          const probe = await stat(link).then(
            () => undefined,
            (cause: unknown) => cause,
          );
          expect(probe).toMatchObject({ code: "EACCES" });
          const result = await inspectLinuxApplication({
            desktopEntry: "vendor-app",
            executable: undefined,
            arguments: [],
            environment,
            home,
            callerDirectory: home,
          });
          expect(result).toMatchObject({
            ok: false,
            error: { reason: "desktop_entry_search_incomplete" },
          });
        } finally {
          await chmod(blocked, 0o755);
        }
      },
    );
  },
);

describe.skipIf(process.platform === "win32")(
  "remaining desktop file id controls",
  () => {
    it("ignores an unreadable sibling that cannot encode the requested ID", async () => {
      const { home, environment } = await fixture();
      const applications = join(home, ".local/share/applications");
      const found = join(applications, "zz-vendor");
      const unreadable = join(applications, "aa-vendor");
      await mkdir(found, { recursive: true });
      await mkdir(unreadable, { recursive: true });
      await writeFile(
        join(found, "org.example.app.desktop"),
        "[Desktop Entry]\nType=Application\nName=High\nExec=notes-app\n",
      );
      await chmod(unreadable, 0o000);

      try {
        const inventory = await inventoryOf("zz-vendor-org.example.app", {
          home,
          environment,
        });

        // This sibling cannot encode the requested ID and is irrelevant to
        // selecting the known matching path.
        expect(inventory.desktop_entry).toMatchObject({
          id: "zz-vendor-org.example.app",
          name: "High",
        });
      } finally {
        await chmod(unreadable, 0o755);
      }
    });

    it.skipIf(process.getuid?.() === 0)(
      "finds a same-root spelling after an applicable probe fails",
      async () => {
        const { home, environment } = await fixture();
        const applications = join(home, ".local/share/applications");
        const blocked = join(home, "blocked");
        await mkdir(join(blocked, "aa"), { recursive: true });
        await mkdir(join(applications, "aa-bb"), { recursive: true });
        await symlink(join(blocked, "aa"), join(applications, "aa"));
        await writeFile(
          join(applications, "aa-bb/app.desktop"),
          "[Desktop Entry]\nType=Application\nName=Matched\nExec=notes-app\n",
        );
        await chmod(blocked, 0o000);
        try {
          await expect(stat(join(applications, "aa"))).rejects.toMatchObject({
            code: "EACCES",
          });
          const inventory = await inventoryOf("aa-bb-app", {
            home,
            environment,
          });
          expect(inventory.desktop_entry).toMatchObject({
            id: "aa-bb-app",
            name: "Matched",
          });
        } finally {
          await chmod(blocked, 0o755);
        }
      },
    );

    it.each(["plain", "vendor-app", "loop-vendor-app"])(
      "ignores unrelated directory-link cycles when resolving %s in a later root",
      async (id) => {
        const { home, environment } = await fixture();
        const applications = join(home, ".local/share/applications");
        await mkdir(applications, { recursive: true });
        await symlink(".", join(applications, "loop"));
        await writeFile(
          join(environment.XDG_DATA_DIRS, "applications", id + ".desktop"),
          "[Desktop Entry]\nType=Application\nName=Selected\nExec=notes-app\n",
        );
        const inventory = await inventoryOf(id, { home, environment });
        expect(inventory.desktop_entry).toMatchObject({ id, name: "Selected" });
      },
    );

    it("keeps an applicable path beyond the depth allowance unresolved", async () => {
      const { home, environment } = await fixture();
      const applications = join(home, ".local/share/applications");
      const directory = join(applications, "one/two/three/four/five");
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "app.desktop"),
        "[Desktop Entry]\nType=Application\nName=High\nExec=notes-app\n",
      );
      const id = "one-two-three-four-five-app";
      await writeFile(
        join(environment.XDG_DATA_DIRS, "applications", id + ".desktop"),
        "[Desktop Entry]\nType=Application\nName=Low\nExec=notes-app\n",
      );
      const result = await inspectLinuxApplication({
        desktopEntry: id,
        executable: undefined,
        arguments: [],
        environment,
        home,
        callerDirectory: home,
      });
      expect(result).toMatchObject({
        ok: false,
        error: { reason: "desktop_entry_search_incomplete" },
      });
    });

    it("searches a directory whose own name ends in .desktop", async () => {
      const { home, environment } = await fixture();
      const directory = join(home, ".local/share/applications/vendor.desktop");
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "app.desktop"),
        "[Desktop Entry]\nType=Application\nName=Nested\nExec=notes-app\n",
      );

      const inventory = await inventoryOf("vendor.desktop-app", {
        home,
        environment,
      });

      expect(inventory.desktop_entry).toMatchObject({
        id: "vendor.desktop-app",
        name: "Nested",
      });
    });

    it("keeps a dash inside a directory name, not only inside the file name", async () => {
      const { home, environment } = await fixture();
      const directory = join(
        home,
        ".local/share/applications/org.example-tools",
      );
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "my-app.desktop"),
        "[Desktop Entry]\nType=Application\nName=Both\nExec=notes-app\n",
      );

      const inventory = await inventoryOf("org.example-tools-my-app", {
        home,
        environment,
      });

      expect(inventory.desktop_entry).toMatchObject({
        id: "org.example-tools-my-app",
        name: "Both",
      });
    });
  },
);

describe.skipIf(process.platform === "win32")(
  "inspectLinuxApplication incomplete desktop file searches",
  () => {
    it("ignores deep trees that cannot encode the requested desktop ID", async () => {
      const { home, environment } = await fixture();
      const share = environment.XDG_DATA_DIRS;
      const applications = join(home, ".local/share/applications");
      // An unrelated deep tree cannot change the requested ID's applicability.
      for (let index = 0; index < 6; index += 1)
        await mkdir(
          join(applications, ...Array<string>(index + 1).fill("deep")),
          { recursive: true },
        );
      await writeFile(
        join(share, "applications/buried-org.example.app.desktop"),
        "[Desktop Entry]\nType=Application\nName=Low\nExec=notes-app\n",
      );

      const inspected = await inspectLinuxApplication({
        desktopEntry: "buried-org.example.app",
        executable: undefined,
        arguments: [],
        environment,
        home,
        callerDirectory: home,
      });

      expect(inspected).toMatchObject({
        ok: true,
        value: {
          inventory: {
            desktop_entry: { id: "buried-org.example.app", name: "Low" },
          },
        },
      });
    });
  },
);

/** The inventory of an installed desktop entry, launched with no arguments. */
const inventoryOf = async (
  desktopEntry: string,
  {
    home,
    environment,
  }: Pick<Awaited<ReturnType<typeof fixture>>, "home" | "environment">,
) => {
  const inspected = await inspectLinuxApplication({
    desktopEntry,
    executable: undefined,
    arguments: [],
    environment,
    home,
    callerDirectory: home,
  });
  if (!inspected.ok) throw new Error(inspected.error.reason);
  return inspected.value.inventory;
};

describe.skipIf(process.platform === "win32")(
  "inspectLinuxApplication working directory",
  () => {
    it("starts an entry with an empty Path in the home directory", async () => {
      const installed = await fixture();
      const { home } = installed;
      await mkdir(join(home, ".local/share/applications"), { recursive: true });
      await writeFile(join(home, "notes"), "#!/bin/sh\nexit 0\n");
      await chmod(join(home, "notes"), 0o755);
      // GLib and KIO launch an entry with an empty `Path=` as if it were unset.
      await writeFile(
        join(home, ".local/share/applications/org.example.unset.desktop"),
        "[Desktop Entry]\nType=Application\nName=Unset\nPath=\nExec=./notes\n",
      );

      const inventory = await inventoryOf("org.example.unset", installed);

      expect(inventory.working_directory).toBe(home);
      expect(inventory.executable.path).toBe(join(home, "notes"));
    });
  },
);

describe.skipIf(process.platform === "win32")(
  "inspectLinuxApplication state and environment",
  () => {
    it("finds the program on the PATH an env prefix sets, not the host's", async () => {
      const installed = await fixture();
      const { home, bin } = installed;
      const opt = join(home, "opt/bin");
      await mkdir(opt, { recursive: true });
      for (const directory of [bin, opt]) {
        await writeFile(join(directory, "notes"), "#!/bin/sh\nexit 0\n");
        await chmod(join(directory, "notes"), 0o755);
      }
      await mkdir(join(home, ".local/share/applications"), { recursive: true });
      await writeFile(
        join(home, ".local/share/applications/org.example.env.desktop"),
        `[Desktop Entry]\nType=Application\nName=Env\nExec=env PATH=${opt}/:/usr/bin XDG_CONFIG_HOME=${home}/settings notes\n`,
      );

      const inventory = await inventoryOf("org.example.env", installed);

      expect(inventory.executable.path).toBe(join(opt, "notes"));
      expect(inventory.state_directories.map((entry) => entry.path)).toContain(
        join(home, "settings/notes"),
      );
    });

    it("reads a relative PATH entry from the folder the entry starts in", async () => {
      const installed = await fixture();
      const { home } = installed;
      const opt = join(home, "opt/bin");
      await mkdir(opt, { recursive: true });
      await writeFile(join(opt, "notes"), "#!/bin/sh\nexit 0\n");
      await chmod(join(opt, "notes"), 0o755);
      await mkdir(join(home, ".local/share/applications"), { recursive: true });
      await writeFile(
        join(home, ".local/share/applications/org.example.dot.desktop"),
        `[Desktop Entry]\nType=Application\nName=Dot\nPath=${opt}\nExec=env PATH=. notes\n`,
      );
      await writeFile(
        join(home, ".local/share/applications/org.example.empty.desktop"),
        `[Desktop Entry]\nType=Application\nName=Empty\nPath=${opt}\nExec=env PATH= notes\n`,
      );

      // `..` after a link climbs from the link's target, so the lookup keeps it.
      const releases = join(home, "releases");
      await mkdir(join(releases, "v2"), { recursive: true });
      await mkdir(join(releases, "bin"));
      await writeFile(join(releases, "bin/notes"), "#!/bin/sh\nexit 0\n");
      await chmod(join(releases, "bin/notes"), 0o755);
      await symlink(join(releases, "v2"), join(home, "opt/current"));
      const linked = `${home}/opt/current/../bin/notes`;
      await writeFile(
        join(home, ".local/share/applications/org.example.link.desktop"),
        `[Desktop Entry]\nType=Application\nName=Link\nExec=${linked}\n`,
      );

      const inventory = await inventoryOf("org.example.dot", installed);
      const viaEmpty = await inventoryOf("org.example.empty", installed);
      const viaLink = await inventoryOf("org.example.link", installed);
      // The launch searches the host's relative entries too, but the export cannot.
      const hostRelative = await inspectLinuxApplication({
        desktopEntry: undefined,
        executable: "notes",
        arguments: [],
        environment: { PATH: "opt/bin" },
        home,
        callerDirectory: home,
      });

      expect(inventory.executable.path).toBe(join(opt, "notes"));
      expect(viaEmpty.executable.path).toBe(join(opt, "notes"));
      expect(viaLink.executable.path).toBe(linked);
      expect(hostRelative).toMatchObject({
        ok: false,
        error: { reason: "executable_on_relative_path" },
      });
    });

    it("names state directories after the entry's full id", async () => {
      const installed = await fixture();
      const { home } = installed;
      await mkdir(join(home, ".config/org.example.notes"), { recursive: true });

      const inventory = await inventoryOf("org.example.notes", installed);

      expect(inventory.state_directories).toContainEqual({
        path: join(home, ".config/org.example.notes"),
        exists_at_start: true,
      });
    });

    it("adds a state folder named after the application in another letter case, such as GIMP's", async () => {
      const installed = await fixture();
      const { home, bin } = installed;
      await writeFile(join(bin, "gimp-2.10"), "#!/bin/sh\nexit 0\n");
      await chmod(join(bin, "gimp-2.10"), 0o755);
      await mkdir(join(home, ".local/share/applications"), { recursive: true });
      await writeFile(
        join(home, ".local/share/applications/gimp.desktop"),
        "[Desktop Entry]\nType=Application\nName=GNU Image Manipulation Program\nExec=gimp-2.10 %U\n",
      );
      await mkdir(join(home, ".config/GIMP/2.10"), { recursive: true });
      await writeFile(join(home, ".config/GIMP/2.10/sessionrc"), "x\n");
      await mkdir(join(home, ".Gimp"));
      const unrelated = [
        ".config/GIMPshop",
        ".config/MyGIMP",
        ".config/Other/GIMP",
      ];
      for (const folder of unrelated)
        await mkdir(join(home, folder), { recursive: true });

      const inventory = await inventoryOf("gimp", installed);

      expect(inventory.state_directories).toEqual(
        expect.arrayContaining([
          { path: join(home, ".config/GIMP"), exists_at_start: true },
          { path: join(home, ".Gimp"), exists_at_start: true },
        ]),
      );
      const paths = inventory.state_directories.map((entry) => entry.path);
      for (const folder of unrelated)
        expect(paths).not.toContain(join(home, folder));
    });

    it("adds the dotfiles in the home named after the application, which it may only read", async () => {
      const installed = await fixture();
      const { home } = installed;
      const named = [".notes-app-cfg.ini", ".notesrc", ".notes.conf"];
      for (const name of [...named, ".notesy", ".other.ini"])
        await writeFile(join(home, name), "x\n");

      const inventory = await inventoryOf("org.example.notes", installed);

      const paths = inventory.state_directories.map((entry) => entry.path);
      expect(paths).toEqual(
        expect.arrayContaining(named.map((name) => join(home, name))),
      );
      expect(paths).not.toContain(join(home, ".notesy"));
      expect(paths).not.toContain(join(home, ".other.ini"));
    });

    it("adds KDE's ~/.config/<name>rc, which the application may first write during the capture", async () => {
      const installed = await fixture();
      const { home } = installed;
      await mkdir(join(home, ".config"), { recursive: true });
      await writeFile(join(home, ".config/org.example.notesrc"), "x\n");

      const inventory = await inventoryOf("org.example.notes", installed);

      expect(inventory.state_directories).toEqual(
        expect.arrayContaining([
          { path: join(home, ".config/notesrc"), exists_at_start: false },
          {
            path: join(home, ".config/org.example.notesrc"),
            exists_at_start: true,
          },
        ]),
      );
    });
  },
);

it.skipIf(process.platform === "win32").each([
  { stage: "desktop entry", closeAt: 1, oversized: false, cancel: false },
  {
    stage: "desktop entry capacity failure",
    closeAt: 1,
    oversized: true,
    cancel: false,
  },
  { stage: "executable header", closeAt: 2, oversized: false, cancel: false },
  {
    stage: "optional Electron probe",
    closeAt: 3,
    oversized: false,
    cancel: false,
  },
  {
    stage: "desktop entry final cancellation",
    closeAt: 1,
    oversized: false,
    cancel: true,
  },
  {
    stage: "capacity failure before final cancellation",
    closeAt: 1,
    oversized: true,
    cancel: true,
  },
])(
  "retains and retries a failed close during $stage",
  async ({ closeAt, oversized, cancel }) => {
    const { home, bin, environment } = await fixture();
    const entry = join(
      environment.XDG_DATA_DIRS,
      "applications/org.example.notes.desktop",
    );
    if (oversized) await writeFile(entry, "x".repeat(1024 * 1024 + 1));
    const controller = new AbortController();
    const reason = new Error("cancelled during close");
    const denied = new Error("descriptor close denied");
    const originalClose = OwnedFileHandle.prototype.close;
    let closes = 0;
    let retained: OwnedFileHandle | undefined;
    const close = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementation(function (this: OwnedFileHandle) {
        closes += 1;
        if (closes === closeAt || this === retained) {
          // oxlint-disable-next-line typescript/no-this-alias -- Retain the exact failed descriptor owner for retry.
          retained = this;
          if (cancel) controller.abort(reason);
          return Promise.reject(denied);
        }
        return originalClose.call(this);
      });
    try {
      const failure = await inspectLinuxApplication(
        {
          desktopEntry: "org.example.notes",
          executable: undefined,
          arguments: [],
          environment,
          home,
          callerDirectory: home,
        },
        controller.signal,
        {
          runQuery: async () => "missing",
          apt: {
            trusted: join(home, "trusted"),
            trustedParts: join(home, "trusted.d"),
            lists: join(home, "lists"),
          },
        },
      ).catch((cause: unknown) => cause);
      expect(retained).toBeDefined();
      if (!(failure instanceof ArtifactFileCleanupFailure))
        throw new Error("expected transferable descriptor cleanup", {
          cause: failure,
        });
      const expectedPath =
        closeAt === 1 ? entry : await realpath(join(bin, "notes-app"));
      expect(failure.cleanup?.resources).toEqual([expectedPath]);
      expect(failure.fileCleanupFailure.owner).toBe(retained);
      expect(failure.fileCleanupFailure.cleanupCause).toBe(denied);
      const outcome = failure.fileCleanupFailure.outcome;
      if (oversized) {
        expect(outcome).toMatchObject({
          kind: "failed",
          cause: {
            maximumBytes: 1024 * 1024,
            observedBytes: BigInt(1024 * 1024 + 1),
          },
        });
      } else if (closeAt === 3) {
        expect(outcome).toMatchObject({
          kind: "failed",
          cause: { kind: "unsupported" },
        });
      } else {
        expect(outcome.kind).toBe("completed");
      }
      if (cancel && !oversized)
        expect(failure.cancellation?.reason).toBe(reason);
      else expect(failure.reason).not.toBe("cancelled");
      const projected = desktopOperationFailure(
        failure,
        controller.signal,
        "capture_desktop_application",
        "Desktop capture",
      );
      expect(projected.cleanupIncomplete).toBe(true);
      expect(projected.cleanupResources).toEqual([expectedPath]);
      await expect(failure.cleanupLease.release()).rejects.toBe(denied);
      expect(projected.cleanupIncomplete).toBe(true);
      close.mockRestore();
      await failure.cleanupLease.release();
      expect(projected.cleanupIncomplete).toBe(false);
      expect(projected.cleanupResources).toEqual([]);
      expect(retained?.handle.fd).toBe(-1);
    } finally {
      close.mockRestore();
      await retained?.close();
    }
  },
);
