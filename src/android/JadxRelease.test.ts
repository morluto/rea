import { expect, it } from "vitest";

import { jadxBridgeIdentity, parseJadxBridgeIdentity } from "./JadxRelease.js";

const declaration = (name: string, version: string): string =>
  `class ReaJadxBridge {\n  static final String BRIDGE_NAME = "${name}";\n  static final String BRIDGE_VERSION = "${version}";\n}\n`;

it("reads the bridge identity the packaged bridge source declares", () => {
  expect(jadxBridgeIdentity()).toEqual({
    name: "rea-jadx-bridge",
    version: expect.stringMatching(/^[A-Za-z0-9._-]+$/u),
  });
});

it("refuses a bridge source that does not declare its identity exactly once", () => {
  expect(parseJadxBridgeIdentity(declaration("rea-jadx-bridge", "12"))).toEqual(
    { name: "rea-jadx-bridge", version: "12" },
  );
  expect(() => parseJadxBridgeIdentity("class ReaJadxBridge {}\n")).toThrow(
    /BRIDGE_NAME exactly once; found 0/u,
  );
  const duplicated = `${declaration("rea-jadx-bridge", "12")}  static final String BRIDGE_VERSION = "13";\n`;
  expect(() => parseJadxBridgeIdentity(duplicated)).toThrow(
    /BRIDGE_VERSION exactly once; found 2/u,
  );
});
