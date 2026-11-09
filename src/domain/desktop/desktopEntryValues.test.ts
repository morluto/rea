import { expect, it } from "vitest";

import {
  escapeDesktopEntryValue,
  expandDesktopExec,
  parseDesktopEntry,
  tokenizeDesktopExec,
} from "./desktopEntry.js";

it.each([
  ["/tmp/workspace ", "/tmp/workspace "],
  ["/tmp/workspace   ", "/tmp/workspace   "],
  ["/tmp/workspace\\s", "/tmp/workspace "],
  ["/tmp/plain-workspace", "/tmp/plain-workspace"],
])("preserves the desktop Path value %j", (wire, path) => {
  const parsed = parseDesktopEntry(
    `[Desktop Entry]\nType=Application\nPath=${wire}\n`,
  );
  if (!parsed.ok) throw new Error(parsed.error);
  expect(parsed.value.path).toBe(path);
});

it.each([
  ["Name", "name", "Notes  "],
  ["TryExec", "try_exec", "/opt/program "],
  ["Icon", "icon", "/icons/icon.svg "],
  ["StartupWMClass", "startup_wm_class", "App class "],
] as const)(
  "preserves the same string-value boundary for %s",
  (key, field, value) => {
    const parsed = parseDesktopEntry(`[Desktop Entry]\n${key}=${value}\n`);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value[field]).toBe(value);
  },
);

it("round-trips values emitted by the existing desktop-entry string formatter", () => {
  for (const value of ["/tmp/workspace ", "  /tmp/workspace ", "/tmp/plain"]) {
    const parsed = parseDesktopEntry(
      `[Desktop Entry]\nPath=${escapeDesktopEntryValue(value)}\n`,
    );
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.path).toBe(value);
  }
});

it("preserves Name suffixes through the existing single-argument field expansion", () => {
  const parsed = parseDesktopEntry(
    "[Desktop Entry]\nName=My application \nExec=notes --title=%c\n",
  );
  if (!parsed.ok) throw new Error(parsed.error);
  const tokens = tokenizeDesktopExec(parsed.value.exec ?? "");
  if (!tokens.ok) throw new Error(tokens.error);
  expect(
    expandDesktopExec(
      tokens.value,
      { name: parsed.value.name, icon: null, location: null },
      [],
    ),
  ).toEqual(["notes", "--title=My application "]);
});

it("keeps existing Type and Terminal token normalization and command separators", () => {
  const parsed = parseDesktopEntry(
    ' [Desktop Entry] \r\n Type = Application  \r\n Terminal = true  \r\n Exec = notes --label "two words"  \r\nName[fr]=Other\r\n[Other]\r\nName=Not selected\r\n',
  );
  if (!parsed.ok) throw new Error(parsed.error);
  expect(parsed.value).toMatchObject({
    type: "Application",
    terminal: true,
    name: null,
  });
  const tokens = tokenizeDesktopExec(parsed.value.exec ?? "");
  if (!tokens.ok) throw new Error(tokens.error);
  expect(tokens.value).toEqual(["notes", "--label", "two words"]);
});

it("does not broaden Type or Terminal recognition by trimming decoded escapes", () => {
  const parsed = parseDesktopEntry(
    "[Desktop Entry]\nType=Application\\s\nTerminal=true\\s\n",
  );
  if (!parsed.ok) throw new Error(parsed.error);
  expect(parsed.value).toMatchObject({ type: "Application ", terminal: false });
});
