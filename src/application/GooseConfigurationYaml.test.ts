import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import { ConfigurationError } from "../domain/configurationErrors.js";
import {
  editGooseConfigurationYaml,
  parseGooseConfigurationYaml,
  stringifyGooseConfigurationYaml,
} from "./GooseConfigurationYaml.js";

const extension = {
  name: "rea",
  cmd: "/fixture/server path",
  args: ["", "--mcp", "a'b"],
  envs: { MODE: "off" },
  type: "stdio",
  enabled: true,
  timeout: 300,
};

describe("Goose YAML source key retention", () => {
  it("updates and removes an extension selected through aliased path keys", () => {
    const source =
      "table: &table extensions\nname: &name rea\n? *table\n:\n  ? *name\n  : {cmd: old, type: stdio}\n";
    const updated = editGooseConfigurationYaml(source, ["extensions", "rea"], {
      cmd: "rea",
      type: "stdio",
    });
    expect(updated).toContain("*table");
    expect(updated).toContain("*name");
    expect(parseGooseConfigurationYaml(updated)).toMatchObject({
      extensions: { rea: { cmd: "rea", type: "stdio" } },
    });
    const removed = editGooseConfigurationYaml(
      updated,
      ["extensions", "rea"],
      undefined,
    );
    expect(removed).not.toContain("*name");
    expect(parseGooseConfigurationYaml(removed)).toMatchObject({
      extensions: {},
    });
    const ambiguous =
      "name: &name rea\nextensions:\n  ? *name\n  : {cmd: first}\n  rea: {cmd: second}\n";
    expect(() =>
      editGooseConfigurationYaml(ambiguous, ["extensions", "rea"], {
        cmd: "rea",
      }),
    ).toThrow(/more than one key resolving to "rea"/);
  });

  it("retains a collection mapping key when an adjacent field changes", () => {
    const source =
      "extensions:\n  rea:\n    cmd: old\n    ? [one, two]\n    : retained\n";
    const parsed = parseGooseConfigurationYaml(source) as {
      extensions: { rea: Record<string, unknown> };
    };
    const updated = editGooseConfigurationYaml(source, ["extensions", "rea"], {
      ...parsed.extensions.rea,
      cmd: "rea",
    });
    const document = parseDocument(updated);
    expect(document.errors).toEqual([]);
    const native = document.toJS({ mapAsMap: true }) as Map<string, unknown>;
    const extensions = native.get("extensions") as Map<string, unknown>;
    const entry = extensions.get("rea") as Map<unknown, unknown>;
    expect([...entry.entries()]).toContainEqual([["one", "two"], "retained"]);
    expect(entry.get("cmd")).toBe("rea");
  });

  it("retains an aliased mapping key when an adjacent launcher field changes", () => {
    const source =
      'label: &label 1\nextensions:\n  rea:\n    cmd: old\n    ? *label\n    : numeric\n    "1": string\n';
    const parsed = parseGooseConfigurationYaml(source) as {
      extensions: { rea: Record<string, unknown> };
    };
    const updated = editGooseConfigurationYaml(source, ["extensions", "rea"], {
      ...parsed.extensions.rea,
      cmd: "rea",
    });
    expect(updated).toContain("*label");
    expect(updated).toContain("numeric");
    expect(updated).toContain('"1": string');
  });

  it("preserves the order of an anchor and a retained non-string key alias", () => {
    const source =
      'extensions:\n  rea:\n    cmd: old\n    shared: &seed value\n    1: *seed\n    "1": string\n';
    const parsed = parseGooseConfigurationYaml(source) as {
      extensions: { rea: Record<string, unknown> };
    };
    const updated = editGooseConfigurationYaml(source, ["extensions", "rea"], {
      ...parsed.extensions.rea,
      cmd: "rea",
    });
    expect(updated.indexOf("&seed")).toBeLessThan(updated.indexOf("*seed"));
    expect(parseGooseConfigurationYaml(updated)).toMatchObject({
      extensions: { rea: { shared: "value", cmd: "rea" } },
    });
  });

  it("retains distinct keys beside an edited field and rejects an ambiguous edit", () => {
    const source =
      'extensions:\n  rea:\n    cmd: old\n    1: numeric\n    "1": string\n';
    const parsed = parseGooseConfigurationYaml(source) as {
      extensions: { rea: Record<string, unknown> };
    };
    const entry = parsed.extensions.rea;
    const updated = editGooseConfigurationYaml(source, ["extensions", "rea"], {
      ...entry,
      cmd: "rea",
    });
    expect(updated).toContain('    1: numeric\n    "1": string');
    expect(updated).toContain("cmd: rea");
    expect(() =>
      editGooseConfigurationYaml(source, ["extensions", "rea"], {
        ...entry,
        "1": "changed",
      }),
    ).toThrow(/source identity is not a plain string key/);
  });

  it("keeps distinct native mapping keys in unchanged extension settings", () => {
    const source =
      'extensions:\n  rea:\n    cmd: old\n    metadata:\n      1: numeric\n      "1": string\n';
    const parsed = parseGooseConfigurationYaml(source) as {
      extensions: { rea: Record<string, unknown> };
    };
    const updated = editGooseConfigurationYaml(source, ["extensions", "rea"], {
      ...parsed.extensions.rea,
      cmd: "rea",
    });
    expect(updated).toContain('      1: numeric\n      "1": string');
    expect(updated).toContain("cmd: rea");
  });
});

describe("Goose YAML 1.2 source facts", () => {
  it("keeps native strings and exact large integer facts distinct", () => {
    const source =
      "on: off\ndate: 2026-11-11\nleading: 0123\nlarge: 9007199254740993\nbool: true\nnil: null\nquoted: 'true'\n";
    expect(parseGooseConfigurationYaml(source)).toEqual({
      on: "off",
      date: "2026-11-11",
      leading: "0123",
      large: 9007199254740993n,
      bool: true,
      nil: null,
      quoted: "true",
    });
    const updated = editGooseConfigurationYaml(
      source,
      ["extensions", "rea"],
      extension,
    );
    expect(updated).toContain("large: 9007199254740993");
    expect(updated).toContain("leading: 0123");
    expect(parseGooseConfigurationYaml(updated)).toMatchObject({
      leading: "0123",
      large: 9007199254740993n,
    });
  });

  it("uses core scalar and literal merge-key facts even with a YAML 1.1 directive", () => {
    const source =
      "%YAML 1.1\n---\ndefaults: &defaults {MODE: off}\nselected: {<<: *defaults}\n";
    const original = {
      defaults: { MODE: "off" },
      selected: { "<<": { MODE: "off" } },
    };
    expect(parseGooseConfigurationYaml(source)).toEqual(original);
    expect(
      parseGooseConfigurationYaml(
        editGooseConfigurationYaml(source, ["extensions", "rea"], extension),
      ),
    ).toEqual({ ...original, extensions: { rea: extension } });
  });

  it.each(["", "# settings note\n", "---\n# settings note\n"])(
    "admits an unwritten mapping root and keeps its comments: %j",
    (source) => {
      expect(parseGooseConfigurationYaml(source)).toEqual({});
      const updated = editGooseConfigurationYaml(
        source,
        ["extensions", "rea"],
        extension,
      );
      expect(parseGooseConfigurationYaml(updated)).toEqual({
        extensions: { rea: extension },
      });
      if (source.includes("settings note"))
        expect(updated).toContain("# settings note");
    },
  );

  it.each([
    "null\n",
    "false\n",
    "[]\n",
    "extensions: null\n",
    "extensions: []\n",
  ])(
    "refuses a source shape that cannot hold the selected extension: %j",
    (source) => {
      expect(() =>
        editGooseConfigurationYaml(source, ["extensions", "rea"], extension),
      ).toThrow(ConfigurationError);
    },
  );

  it.each([
    [
      "extensions:\n  rea: {cmd: first}\n  rea: {cmd: second}\n",
      ["extensions", "rea"],
    ],
    ["extensions: {}\nextensions: {}\n", ["extensions"]],
    [
      "extensions:\n  rea:\n    cmd: first\n    cmd: second\n",
      ["extensions", "rea", "cmd"],
    ],
  ] as const)(
    "reports duplicate source members with their owned key path",
    (source, path) => {
      let failure: unknown;
      try {
        parseGooseConfigurationYaml(source);
      } catch (cause: unknown) {
        failure = cause;
      }
      expect(failure).toBeInstanceOf(ConfigurationError);
      expect(failure).toMatchObject({ kind: "shadowed_member", path });
      expect(failure).toHaveProperty(
        "message",
        `Goose YAML contains a duplicate mapping member at ${path.join(".")}`,
      );
      expect(() =>
        editGooseConfigurationYaml(source, ["extensions", "rea"], extension),
      ).toThrow(`duplicate mapping member at ${path.join(".")}`);
    },
  );

  it.each([
    "extensions: [\n",
    "custom: !unknown tag\n",
    "extensions: *absent\n",
  ])(
    "retains malformed or unresolved YAML as a typed refusal: %j",
    (source) => {
      expect(() => parseGooseConfigurationYaml(source)).toThrow(
        ConfigurationError,
      );
      expect(() =>
        editGooseConfigurationYaml(source, ["extensions", "rea"], extension),
      ).toThrow(ConfigurationError);
    },
  );
  it.each([
    "value: &loop {self: *loop}\n",
    "extensions: &loop {rea: {args: [*loop]}}\n",
  ])(
    "refuses cyclic source aliases before producing a recursive configuration value",
    (source) => {
      expect(() => parseGooseConfigurationYaml(source)).toThrow(
        ConfigurationError,
      );
      expect(() =>
        editGooseConfigurationYaml(source, ["extensions", "rea"], extension),
      ).toThrow(ConfigurationError);
    },
  );
});

describe("Goose extension edits", () => {
  it("retains comments, unrelated settings and exact cmd/args/envs", () => {
    const source =
      "# config note\nprovider: fixture # provider note\nprompt: |\n  keep this long prompt and formatting\nextensions:\n  other: {cmd: peer, args: [off]} # peer note\n  rea: # registration note\n    cmd: old # executable note\n    args: # arguments note\n      - old # argument note\n    envs: # environment note\n      MODE: old # mode note\n";
    const updated = editGooseConfigurationYaml(
      source,
      ["extensions", "rea"],
      extension,
    );
    expect(parseGooseConfigurationYaml(updated)).toEqual({
      provider: "fixture",
      prompt: "keep this long prompt and formatting\n",
      extensions: { other: { cmd: "peer", args: ["off"] }, rea: extension },
    });
    for (const note of [
      "config note",
      "provider note",
      "peer note",
      "registration note",
      "executable note",
      "arguments note",
      "argument note",
      "environment note",
      "mode note",
    ])
      expect(updated.split(note)).toHaveLength(2);
    expect(updated).toContain(
      "prompt: |\n  keep this long prompt and formatting\n",
    );
    expect(parseDocument(updated, { schema: "core" }).errors).toEqual([]);
  });

  it("moves a unique argument's comment with its value without duplicating removed annotations", () => {
    const source =
      "extensions:\n  rea:\n    cmd: old\n    args:\n      - --mcp # protocol\n      - dropped # removed\n";
    const updated = editGooseConfigurationYaml(source, ["extensions", "rea"], {
      cmd: "new",
      args: ["", "--mcp"],
    });
    expect(updated).toMatch(/- --mcp # protocol/);
    expect(updated.split("# removed")).toHaveLength(2);
    expect(parseGooseConfigurationYaml(updated)).toEqual({
      extensions: { rea: { cmd: "new", args: ["", "--mcp"] } },
    });
  });

  it.each([undefined, extension])(
    "preserves surviving consumers of a replaced anchored entry: %j",
    (value) => {
      const source =
        "defaults: &defaults {MODE: off}\nextensions:\n  rea: &server\n    cmd: old\n    args: [--old]\n    envs: *defaults\n  other: *server # independent peer\nobserver: *defaults\n";
      const updated = editGooseConfigurationYaml(
        source,
        ["extensions", "rea"],
        value,
      );
      expect(parseGooseConfigurationYaml(updated)).toEqual({
        defaults: { MODE: "off" },
        extensions: {
          ...(value === undefined ? {} : { rea: value }),
          other: { cmd: "old", args: ["--old"], envs: { MODE: "off" } },
        },
        observer: { MODE: "off" },
      });
      expect(updated).toContain("# independent peer");
    },
  );

  it("edits an aliased extensions table without mutating its original owner", () => {
    const source =
      "defaults: &servers\n  peer: {cmd: old}\nextensions: *servers # extension table\n";
    const updated = editGooseConfigurationYaml(
      source,
      ["extensions", "rea"],
      extension,
    );
    expect(parseGooseConfigurationYaml(updated)).toEqual({
      defaults: { peer: { cmd: "old" } },
      extensions: { peer: { cmd: "old" }, rea: extension },
    });
    expect(updated).toContain("# extension table");
  });

  it("deleting a missing extension leaves the original document intact", () => {
    const source = "# exact original\nprovider: fixture\n";
    expect(
      editGooseConfigurationYaml(source, ["extensions", "rea"], undefined),
    ).toBe(source);
  });

  it("serializes fresh values with a YAML 1.2 scalar round trip", () => {
    const document = {
      provider: "off",
      extensions: { rea: extension },
      date: "2026-11-11",
      large: 9007199254740993n,
    };
    const text = stringifyGooseConfigurationYaml(document);
    expect(parseGooseConfigurationYaml(text)).toEqual(document);
    expect(
      parseDocument(text, { schema: "core", intAsBigInt: true }).errors,
    ).toEqual([]);
  });
});

describe("pinned Goose serde_yaml scalar resolution", () => {
  it.each([
    ["0123", "0123"],
    ["-0123", "-0123"],
    ["+0123", "+0123"],
    ["00", "00"],
    ["0", 0],
    ["+0", 0],
    ["-0", 0],
    ["-12", -12],
    ["0b11", 3],
    ["-0b11", -3],
    ["+0b11", 3],
    ["0o17", 15],
    ["-0o17", -15],
    ["+0o17", 15],
    ["0xAf", 175],
    ["-0xAf", -175],
    ["+0xAf", 175],
    ["0XAF", "0XAF"],
    ["1_000", "1_000"],
    ["0b1_0", "0b1_0"],
    ["0123.0", 123],
    ["0123e2", 12300],
    [".5", 0.5],
    ["1.", 1],
    ["-1e-3", -0.001],
    ["1e309", "1e309"],
    ["-1e309", "-1e309"],
    [".inf", Infinity],
    ["-.INF", -Infinity],
    ["+.Inf", Infinity],
    [".nan", NaN],
    ["+.nan", "+.nan"],
    ["on", "on"],
    ["off", "off"],
    ["true", true],
    ["FALSE", false],
    ["2026-11-11", "2026-11-11"],
    ["9223372036854775807", 9223372036854775807n],
    ["-9223372036854775808", -9223372036854775808n],
    ["18446744073709551615", 18446744073709551615n],
    [
      "340282366920938463463374607431768211456",
      Number("340282366920938463463374607431768211456"),
    ],
    ["9".repeat(400), "9".repeat(400)],
    ["!!int +0b11", 3],
    ["!!float 0123", 123],
    ["!!float 1", 1],
    ["!!int |-\n  12", 12],
    ["!!float |-\n  1.5", 1.5],
    ["!!bool TRUE", true],
    ["!!null NULL", null],
    ["'0123'", "0123"],
    ["!!str 0b11", "0b11"],
  ])(
    "admits native scalar %s without changing its fact",
    (source, expected) => {
      expect(parseGooseConfigurationYaml(`value: ${source}\n`)).toEqual({
        value: expected,
      });
    },
  );

  it.each([
    "!!int 0123",
    "!!int -0123",
    "!!bool on",
    '!!null ""',
    "!!int |\n  12\n",
    "!!float |\n  1.5\n",
    "!!int 1_000",
    "!!int 0XAF",
    "!!float 1e309",
    "!!float 0xAf",
    "!!int 18446744073709551616",
    "18446744073709551616",
    "-9223372036854775809",
  ])(
    "rejects scalar %s that the native Value visitor cannot admit",
    (source) => {
      expect(() => parseGooseConfigurationYaml(`value: ${source}\n`)).toThrow();
    },
  );
});

it("materializes an alias whose sibling anchor the refresh replaces", () => {
  const source =
    "extensions:\n  rea:\n    cmd: &launcher /old/rea\n    envs: {REA_LAUNCHER: *launcher}\n";
  const out = editGooseConfigurationYaml(source, ["extensions", "rea"], {
    cmd: "/new/rea",
    envs: { REA_LAUNCHER: "/old/rea" },
  });
  expect(parseGooseConfigurationYaml(out)).toMatchObject({
    extensions: {
      rea: { cmd: "/new/rea", envs: { REA_LAUNCHER: "/old/rea" } },
    },
  });
});

it("edits a field whose key is an alias to a shared string, keeping the alias", () => {
  const source =
    "field: &field envs\nextensions:\n  rea:\n    cmd: rea\n    *field : {A: '1'}\n";
  const out = editGooseConfigurationYaml(source, ["extensions", "rea"], {
    cmd: "rea",
    envs: { A: "2" },
  });
  expect(out).toContain("*field");
  expect(parseGooseConfigurationYaml(out)).toMatchObject({
    field: "envs",
    extensions: { rea: { cmd: "rea", envs: { A: "2" } } },
  });
});

it("keeps an anchored value with an aliased key ahead of its later aliases", () => {
  const source =
    "field: &field envs\nextensions:\n  rea:\n    cmd: old\n    *field : &settings {A: '1'}\n    1: *settings\n    \"1\": string\n";
  const out = editGooseConfigurationYaml(source, ["extensions", "rea"], {
    cmd: "new",
    envs: { A: "1" },
    1: "string",
  });
  expect(out.indexOf("&settings")).toBeLessThan(out.indexOf("*settings"));
  expect(parseGooseConfigurationYaml(out)).toMatchObject({
    extensions: { rea: { cmd: "new", envs: { A: "1" } } },
  });
});
