import { expect, it } from "vitest";

import { jadxBridgeIdentity, parseJadxBridgeIdentity } from "./JadxRelease.js";

const declaration = (name: string, version: string): string =>
  `class ReaJadxBridge {\n  static final String BRIDGE_NAME = "${name}";\n  static final String BRIDGE_VERSION = "${version}";\n}\n`;

const identity = (name: string, version: string) => ({
  ok: true,
  value: { name, version },
});

const refusal = (pattern: RegExp) => ({
  ok: false,
  error: expect.stringMatching(pattern),
});

it("reads the bridge identity the packaged bridge source declares", () => {
  expect(jadxBridgeIdentity()).toEqual({
    ok: true,
    value: {
      name: "rea-jadx-bridge",
      version: expect.stringMatching(/^[A-Za-z0-9._-]+$/u),
    },
  });
});

it("refuses a bridge source that does not declare its identity exactly once", () => {
  expect(parseJadxBridgeIdentity(declaration("rea-jadx-bridge", "12"))).toEqual(
    identity("rea-jadx-bridge", "12"),
  );
  expect(parseJadxBridgeIdentity("class ReaJadxBridge {}\n")).toEqual(
    refusal(/BRIDGE_NAME exactly once; found 0/u),
  );
  const duplicated = declaration("rea-jadx-bridge", "12").replace(
    "}\n",
    '  static final String BRIDGE_VERSION = "13";\n}\n',
  );
  expect(parseJadxBridgeIdentity(duplicated)).toEqual(
    refusal(/BRIDGE_VERSION exactly once; found 2/u),
  );
});

it("reads only the outer class's own fields, whatever their formatting", () => {
  const source = [
    '// static final String BRIDGE_VERSION = "line-comment";',
    "class ReaJadxBridge {",
    '  /* static final String BRIDGE_VERSION = "block-comment"; */',
    '  private   static final String BRIDGE_NAME="rea-jadx-bridge" ;',
    "  public static final String",
    '      BRIDGE_VERSION = "12";',
    '  static final String BRACE = "}{";',
    "  private static final class Nested {",
    '    static final String BRIDGE_VERSION = "nested";',
    "  }",
    "  void run() {",
    '    String BRIDGE_NAME = "local";',
    "  }",
    "}",
    "",
  ].join("\n");

  expect(parseJadxBridgeIdentity(source)).toEqual(
    identity("rea-jadx-bridge", "12"),
  );
});

it("ignores other top-level types in the bridge source", () => {
  const sibling = [
    "final class Helper {",
    '  static final String BRIDGE_NAME = "helper";',
    '  static final String BRIDGE_VERSION = "helper";',
    "}",
    "",
  ].join("\n");

  expect(
    parseJadxBridgeIdentity(
      `${sibling}${declaration("rea-jadx-bridge", "12")}`,
    ),
  ).toEqual(identity("rea-jadx-bridge", "12"));
  expect(
    parseJadxBridgeIdentity(`${sibling}class ReaJadxBridgeV2 {}\n`),
  ).toEqual(refusal(/top-level class ReaJadxBridge exactly once; found 0/u));
  expect(parseJadxBridgeIdentity(`${sibling}class ReaJadxBridge {}\n`)).toEqual(
    refusal(/BRIDGE_NAME exactly once; found 0/u),
  );
});
