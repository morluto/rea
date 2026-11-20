import { expect, it } from "vitest";

import {
  absoluteXdgConfigHome,
  mcporterXdgConfigHome,
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

it.each([
  [undefined, undefined],
  ["", undefined],
  ["relative", undefined],
  [" ~/xdg ", "/home/user/xdg"],
  ["~", "/home/user"],
  [" /custom ", "/custom"],
])("reads XDG_CONFIG_HOME=%j as MCPorter's folder %j", (value, expected) => {
  const env = value === undefined ? {} : { XDG_CONFIG_HOME: value };
  expect(mcporterXdgConfigHome({ home, platform: "linux", env })).toBe(
    expected,
  );
});
