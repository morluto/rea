import { describe, expect, it } from "vitest";

import {
  escapeDesktopEntryValue,
  expandDesktopExec,
  formatDesktopExec,
  parseDesktopEntry,
  replaceDesktopExec,
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

  it.each(["\u2028", "\u2029"])(
    "keeps Unicode separator %j inside string and list values",
    (separator) => {
      const parsed = parseDesktopEntry(
        `[Desktop Entry]\nType=Application\nName=${separator}Notes${separator}\nExec=notes --title "A${separator}B"\nCategories=Utility;A${separator}B;\n`,
      );
      expect(parsed).toMatchObject({
        ok: true,
        value: {
          name: `${separator}Notes${separator}`,
          exec: `notes --title "A${separator}B"`,
          categories: ["Utility", `A${separator}B`],
        },
      });
    },
  );
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

describe("formatDesktopExec", () => {
  it("round-trips arguments that contain spaces and quotes", () => {
    const exec = '"/opt/My App/run" --title "say \\"hi\\"" %F';
    const tokens = tokenizeDesktopExec(exec);
    if (!tokens.ok) throw new Error(tokens.error);
    expect(tokenizeDesktopExec(formatDesktopExec(tokens.value))).toEqual(
      tokens,
    );
  });

  it("escapes the desktop-entry value so a trailing backslash survives a second parse", () => {
    const program = "/opt/app\\dir\\";
    const quoted = 'say "hi"\\';
    const argv = [program, "--title", quoted, "%U"];
    // Command quoting doubles each backslash; the value layer doubles them
    // again, which is the form gio accepts. One fewer level leaves a trailing
    // backslash that escapes the closing quote.
    const escaped = String.raw`Exec="/opt/app\\\\dir\\\\" --title "say \\"hi\\"\\\\" %U`;
    const text = `[Desktop Entry]\nType=Application\nName=App\n${escaped}\n`;

    const parsed = parseDesktopEntry(text);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(tokenizeDesktopExec(parsed.value.exec ?? "")).toEqual({
      ok: true,
      value: argv,
    });
    expect(escapeDesktopEntryValue(formatDesktopExec(argv))).toBe(
      escaped.slice("Exec=".length),
    );

    const rewritten = replaceDesktopExec(
      text,
      formatDesktopExec([program, "--no-sandbox", "--title", quoted, "%U"]),
    );
    if (!rewritten.ok) throw new Error(rewritten.error);
    const again = parseDesktopEntry(rewritten.value);
    if (!again.ok) throw new Error(again.error);
    expect(tokenizeDesktopExec(again.value.exec ?? "")).toEqual({
      ok: true,
      value: [program, "--no-sandbox", "--title", quoted, "%U"],
    });
    expect(rewritten.value).toContain(
      String.raw`Exec="/opt/app\\\\dir\\\\" --no-sandbox --title "say \\"hi\\"\\\\" %U`,
    );
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
  it("keeps env assignments as the program's environment", () => {
    expect(
      unwrapDesktopCommand([
        "env",
        "BAMF_DESKTOP_FILE_HINT=/x.desktop",
        "PATH=/opt/notes/bin:/usr/bin",
        "PATH=/opt/notes/bin",
        "notes",
      ]),
    ).toEqual({
      kind: "direct",
      program: "notes",
      index: 4,
      environment: {
        BAMF_DESKTOP_FILE_HINT: "/x.desktop",
        PATH: "/opt/notes/bin",
      },
    });
    expect(
      Object.entries(
        unwrapDesktopCommand(["env", "__proto__=x", "notes"]).environment,
      ),
    ).toEqual([["__proto__", "x"]]);
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
    ).toEqual({
      kind: "flatpak",
      program: "/usr/bin/flatpak",
      environment: {},
      application_id: "net.cozic.joplin_desktop",
    });
  });

  it.each([
    [["--branch", "stable", "org.example.Notes"]],
    [["--filesystem", "home", "-d", "--command", "notes", "org.example.Notes"]],
    [["--user", "org.example.Notes//beta", "--new"]],
    [["--", "org.example.Notes/x86_64/stable"]],
  ])(
    "reads the flatpak application id after option values: %j",
    (arguments_) => {
      expect(unwrapDesktopCommand(["flatpak", "run", ...arguments_])).toEqual(
        expect.objectContaining({
          kind: "flatpak",
          application_id: "org.example.Notes",
        }),
      );
    },
  );

  it("leaves the flatpak application id unknown when no operand names one", () => {
    expect(
      unwrapDesktopCommand(["flatpak", "run", "--branch", "stable"]),
    ).toMatchObject({ kind: "flatpak", application_id: null });
  });
});
