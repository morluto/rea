import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import {
  absoluteXdgConfigHome,
  xdgConfigHomeOrDefault,
} from "./ClientConfigRoots.js";

const home = "/home/user";

it.each([
  [undefined, "/home/user/.config", "/home/user/.config"],
  ["", "/home/user/.config", "/home/user/.config"],
  ["relative", "relative", "/home/user/.config"],
  ["/custom", "/custom", "/custom"],
])(
  "reads XDG_CONFIG_HOME=%j as xdg-basedir %s and the XDG rule %s",
  (value, basedir, specification) => {
    const env = value === undefined ? {} : { XDG_CONFIG_HOME: value };
    expect(xdgConfigHomeOrDefault({ home, env })).toBe(basedir);
    expect(absoluteXdgConfigHome({ home, env })).toBe(specification);
  },
);

// Client root semantics differ per reader, so they are derived only here.
it("keeps client configuration-root variables in one owner", async () => {
  const directory = fileURLToPath(new URL(".", import.meta.url));
  const offenders: string[] = [];
  for (const name of await readdir(directory)) {
    if (
      !name.endsWith(".ts") ||
      name.endsWith(".test.ts") ||
      name === "ClientConfigRoots.ts"
    )
      continue;
    const text = await readFile(join(directory, name), "utf8");
    if (/\.(?:XDG_CONFIG_HOME|VSCODE_APPDATA|VSCODE_PORTABLE)\b/u.test(text))
      offenders.push(name);
  }
  expect(offenders).toEqual([]);
});
