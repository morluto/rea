import { describe, expect, it } from "vitest";

import {
  expandDesktopExec,
  parseDesktopEntry,
  tokenizeDesktopExec,
  unwrapDesktopCommand,
} from "./desktopEntry.js";

describe("parseDesktopEntry", () => {
  it("reads the main group and ignores localized keys and other groups", () => {
    const parsed = parseDesktopEntry(
      [
        "# comment",
        "[Desktop Entry]",
        "Type=Application",
        "Name[fr]=Bloc-notes",
        "Name=Mousepad",
        "Exec=mousepad %U",
        "Icon=org.xfce.mousepad",
        "Categories=Utility;TextEditor;GTK;",
        "MimeType=text/plain;",
        "Terminal=false",
        "[Desktop Action window]",
        "Name=New Window",
        "Exec=mousepad --new-window",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      ok: true,
      value: {
        type: "Application",
        name: "Mousepad",
        exec: "mousepad %U",
        try_exec: null,
        path: null,
        icon: "org.xfce.mousepad",
        startup_wm_class: null,
        categories: ["Utility", "TextEditor", "GTK"],
        mime_types: ["text/plain"],
        terminal: false,
      },
    });
  });

  it("undoes value escapes, keeping escaped semicolons inside list items", () => {
    const parsed = parseDesktopEntry(
      "[Desktop Entry]\nName=Two\\sWords\nCategories=A\\;B;C\n",
    );
    expect(parsed.ok && parsed.value.name).toBe("Two Words");
    expect(parsed.ok && parsed.value.categories).toEqual(["A;B", "C"]);
  });

  it("refuses text without a Desktop Entry group", () => {
    expect(parseDesktopEntry("[Other]\nName=x\n")).toEqual({
      ok: false,
      error: "missing_desktop_entry_group",
    });
  });
});

describe("tokenizeDesktopExec", () => {
  it("splits on spaces and honours quoted arguments and their escapes", () => {
    expect(
      tokenizeDesktopExec('"/opt/My App/run" --title "say \\"hi\\"" %F'),
    ).toEqual({
      ok: true,
      value: ["/opt/My App/run", "--title", 'say "hi"', "%F"],
    });
  });

  it("refuses an unterminated quote and an empty command", () => {
    expect(tokenizeDesktopExec('"open')).toEqual({
      ok: false,
      error: "unterminated_quote",
    });
    expect(tokenizeDesktopExec("   ")).toEqual({
      ok: false,
      error: "empty_command",
    });
  });
});

describe("expandDesktopExec", () => {
  const context = { icon: "editor", name: "Editor", location: "/e.desktop" };

  it("drops file codes, expands icon, name and location, and appends arguments", () => {
    expect(
      expandDesktopExec(
        ["editor", "%U", "%i", "--class=%c", "--from=%k", "100%%"],
        context,
        ["/home/ada/notes.txt"],
      ),
    ).toEqual([
      "editor",
      "--icon",
      "editor",
      "--class=Editor",
      "--from=/e.desktop",
      "100%",
      "/home/ada/notes.txt",
    ]);
  });

  it("leaves out %i when the entry has no icon", () => {
    expect(
      expandDesktopExec(["editor", "%i"], { ...context, icon: null }, []),
    ).toEqual(["editor"]);
  });
});

describe("unwrapDesktopCommand", () => {
  it("skips env assignments to the program", () => {
    expect(
      unwrapDesktopCommand([
        "env",
        "BAMF_DESKTOP_FILE_HINT=/x.desktop",
        "/snap/bin/firefox",
      ]),
    ).toEqual({ kind: "direct", program: "/snap/bin/firefox" });
  });

  it("recognises flatpak launchers and their application id", () => {
    expect(
      unwrapDesktopCommand([
        "/usr/bin/flatpak",
        "run",
        "--branch=stable",
        "--command=joplin",
        "net.cozic.joplin_desktop",
        "@@u",
        "@@",
      ]),
    ).toEqual({ kind: "flatpak", application_id: "net.cozic.joplin_desktop" });
  });
});
