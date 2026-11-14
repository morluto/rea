import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  effectiveClientServer,
  parseClientConfiguration,
  serializeClientConfiguration,
  withClientServers,
} from "./ClientConfigurationDocument.js";
import { refreshClientRegistration } from "./ClientRegistration.js";
import { supportedClients } from "./SupportedClients.js";

import {
  editHermesConfigurationYaml,
  parseHermesConfigurationYaml,
  stringifyHermesConfigurationYaml,
} from "./HermesConfigurationYaml.js";

it("uses the first inherited mapping when creating an override", () => {
  const source =
    "first: &first\n  mcp_servers:\n    one: {command: first}\nsecond: &second\n  mcp_servers:\n    two: {command: second}\n<<: [*first, *second]\n";
  const updated = editHermesConfigurationYaml(source, ["mcp_servers", "rea"], {
    command: "rea",
  });
  const parsed = parseHermesConfigurationYaml(updated) as {
    mcp_servers: Record<string, unknown>;
  };
  expect(parsed.mcp_servers).toEqual({
    one: { command: "first" },
    rea: { command: "rea" },
  });
  expect(
    parseHermesConfigurationYaml(
      updated.replace("command: first", "command: changed"),
    ),
  ).toMatchObject({
    mcp_servers: { one: { command: "changed" } },
  });
});

it("refuses an inherited override when an existing anchor name is shadowed", () => {
  const source =
    "shared: &shared\n  mcp_servers: &table\n    other: {command: first}\nshadow: &table {other: {command: second}}\n<<: *shared\n";
  expect(() =>
    editHermesConfigurationYaml(source, ["mcp_servers", "rea"], {
      command: "rea",
    }),
  ).toThrow(/anchor is shadowed/);
});

it("retains inherited YAML settings when updating a registration", () => {
  const source =
    "defaults: &defaults\n  enabled: false\nmcp_servers:\n  rea:\n    <<: *defaults\n    command: old\n";
  const parsed = parseHermesConfigurationYaml(source) as {
    mcp_servers: { rea: Record<string, unknown> };
  };
  const updated = editHermesConfigurationYaml(source, ["mcp_servers", "rea"], {
    ...parsed.mcp_servers.rea,
    command: "rea",
  });
  expect(updated).toContain("<<: *defaults");
  const changedDefault = updated.replace("enabled: false", "enabled: true");
  expect(parseHermesConfigurationYaml(changedDefault)).toMatchObject({
    mcp_servers: { rea: { command: "rea", enabled: true } },
  });
  const overridden = editHermesConfigurationYaml(
    source,
    ["mcp_servers", "rea"],
    { ...parsed.mcp_servers.rea, command: "rea", enabled: true },
  );
  expect(overridden).toContain("<<: *defaults");
  expect(parseHermesConfigurationYaml(overridden)).toMatchObject({
    mcp_servers: { rea: { command: "rea", enabled: true } },
  });
  expect(() =>
    editHermesConfigurationYaml(source, ["mcp_servers", "rea"], {
      command: "rea",
    }),
  ).toThrow(/Cannot remove inherited YAML setting/);
});

it("preserves annotations on changed registration mappings and scalar fields", () => {
  const source =
    "mcp_servers:\n  rea: # registration note\n    command: old # command note\n    env: # environment note\n      MODE: old # mode note\n    args: # arguments note\n      - old # argument note\n";
  const updated = editHermesConfigurationYaml(source, ["mcp_servers", "rea"], {
    command: "new",
    env: { MODE: "new" },
    args: ["new"],
  });
  expect(parseHermesConfigurationYaml(updated)).toEqual({
    mcp_servers: {
      rea: { command: "new", env: { MODE: "new" }, args: ["new"] },
    },
  });
  for (const comment of [
    "registration note",
    "command note",
    "environment note",
    "mode note",
    "arguments note",
    "argument note",
  ])
    expect(updated.split(comment)).toHaveLength(2);
});

it("refreshes an anchored entry without changing another server's resolved value", () => {
  const source =
    "mcp_servers:\n  rea: &server\n    command: old\n    enabled: false\n  other: *server # Independent server\n";
  const updated = editHermesConfigurationYaml(source, ["mcp_servers", "rea"], {
    command: "rea",
    enabled: true,
  });
  expect(parseHermesConfigurationYaml(updated)).toEqual({
    mcp_servers: {
      rea: { command: "rea", enabled: true },
      other: { command: "old", enabled: false },
    },
  });
  expect(updated).toContain("# Independent server");
});

it("keeps comments once when an updated anchored entry has a surviving consumer", () => {
  const source =
    "mcp_servers:\n  rea: &server # registration note\n    # command key note\n    command: old # command note\n    enabled: true # enabled note\n    env: # environment note\n      MODE: old # mode note\n  other: *server\n";
  const updated = editHermesConfigurationYaml(source, ["mcp_servers", "rea"], {
    command: "new",
    enabled: true,
    env: { MODE: "new" },
  });
  expect(parseHermesConfigurationYaml(updated)).toEqual({
    mcp_servers: {
      rea: { command: "new", enabled: true, env: { MODE: "new" } },
      other: { command: "old", enabled: true, env: { MODE: "old" } },
    },
  });
  for (const comment of [
    "registration note",
    "command key note",
    "command note",
    "enabled note",
    "environment note",
    "mode note",
  ])
    expect(updated.split(comment)).toHaveLength(2);
});

describe("Hermes surviving anchor definitions", () => {
  for (const shadowed of [false, true]) {
    it.each([undefined, { command: "rea" }])(
      `retains surviving shared target identity with shadowed=${shadowed} when writing %j`,
      (entry) => {
        const source =
          "defaults: &settings {MODE: 'off'}\nmcp_servers:\n  rea: &server\n    command: old\n    env: *settings\n" +
          (shadowed ? "later: &settings {MODE: 'later'}\n" : "") +
          "observer: *server\npeer: *settings\n";
        const result = parse(
          editHermesConfigurationYaml(source, ["mcp_servers", "rea"], entry),
        );
        expect(result.defaults).toEqual({ MODE: "off" });
        expect(result.observer.env).toBe(result.defaults);
        expect(result.peer).toBe(shadowed ? result.later : result.defaults);
        if (shadowed) expect(result.peer).not.toBe(result.defaults);
      },
    );
  }

  it.each(["settings", "missing"])(
    "still refuses a surviving %s dependency that cannot be retained",
    (reference) => {
      const source = `defaults: &settings {dependency: *${reference}}\nmcp_servers:\n  rea: &server {env: *settings}\nobserver: *server\n`;
      expect(() =>
        editHermesConfigurationYaml(source, ["mcp_servers", "rea"], undefined),
      ).toThrow();
    },
  );
});

describe("Hermes copied anchor comments", () => {
  it("retains the removed anchor definition comment at its surviving consumer", () => {
    const source =
      "mcp_servers:\n  rea: &server {command: old} # Keep definition explanation\n  other: *server\n";
    const updated = editHermesConfigurationYaml(
      source,
      ["mcp_servers", "rea"],
      undefined,
    );
    expect(parseHermesConfigurationYaml(updated)).toEqual({
      mcp_servers: { other: { command: "old" } },
    });
    expect(updated).toContain("# Keep definition explanation");
  });

  it.each([undefined, { command: "rea" }])(
    "combines definition and consumer comments without copying shared definitions twice when writing %j",
    (entry) => {
      const source =
        "mcp_servers:\n  rea:\n    # Definition leading note\n    &server {command: old} # Definition trailing note\n  other:\n    # Consumer leading note\n    *server # Consumer trailing note\nobserver: *server # Later consumer note\n";
      const updated = editHermesConfigurationYaml(
        source,
        ["mcp_servers", "rea"],
        entry,
      );
      const result = parse(updated);
      expect(result).toEqual({
        mcp_servers: {
          ...(entry === undefined ? {} : { rea: entry }),
          other: { command: "old" },
        },
        observer: { command: "old" },
      });
      expect(result.observer).toBe(result.mcp_servers.other);
      for (const comment of [
        "Definition leading note",
        "Definition trailing note",
        "Consumer leading note",
        "Consumer trailing note",
        "Later consumer note",
      ])
        expect(updated.split(comment)).toHaveLength(2);
    },
  );
});

describe("Hermes anchored-entry consumers", () => {
  it.each([undefined, { command: "rea" }])(
    "preserves an anchored registration key when writing %j",
    (entry) => {
      const source =
        "mcp_servers:\n  &server_name rea: {command: old}\nobserver: *server_name # Keep registration name\n";
      const updated = editHermesConfigurationYaml(
        source,
        ["mcp_servers", "rea"],
        entry,
      );
      expect(parseHermesConfigurationYaml(updated)).toEqual({
        mcp_servers: entry === undefined ? {} : { rea: entry },
        observer: "rea",
      });
      expect(updated).toContain("# Keep registration name");
      if (entry !== undefined) {
        expect(updated).toContain("&server_name rea:");
        expect(updated).toContain("*server_name");
      }
    },
  );

  it("preserves both key and value consumers of a removed pair", () => {
    const source =
      "mcp_servers:\n  &server_name rea: &server {command: old}\n  other: *server\nobserver: *server_name\nlater: &server_name later\nlater_observer: *server_name\n";
    expect(
      parseHermesConfigurationYaml(
        editHermesConfigurationYaml(source, ["mcp_servers", "rea"], undefined),
      ),
    ).toEqual({
      mcp_servers: { other: { command: "old" } },
      observer: "rea",
      later: "later",
      later_observer: "later",
    });
  });

  it.each([undefined, { command: "rea" }])(
    "preserves references to an anchored child when writing %j",
    (entry) => {
      const source =
        "mcp_servers:\n  rea:\n    command: old\n    env: &settings\n      MODE: 'off'\n  other:\n    command: other\n    env: *settings\n";
      const result = parseHermesConfigurationYaml(
        editHermesConfigurationYaml(source, ["mcp_servers", "rea"], entry),
      );
      expect(result).toEqual({
        mcp_servers: {
          ...(entry === undefined ? {} : { rea: entry }),
          other: { command: "other", env: { MODE: "off" } },
        },
      });
    },
  );

  it.each([undefined, { command: "rea" }])(
    "retains nested alias comments when writing %j",
    (entry) => {
      const source =
        "defaults: &settings {MODE: 'old'}\nmcp_servers:\n  rea: &entry\n    command: old\n    env:\n      # Keep nested leading comment\n      *settings # Keep nested reference comment\n  other: *entry # Keep external reference comment\n";
      const updated = editHermesConfigurationYaml(
        source,
        ["mcp_servers", "rea"],
        entry,
      );
      expect(parseHermesConfigurationYaml(updated)).toEqual({
        defaults: { MODE: "old" },
        mcp_servers: {
          ...(entry === undefined ? {} : { rea: entry }),
          other: { command: "old", env: { MODE: "old" } },
        },
      });
      expect(updated).toContain("# Keep nested leading comment");
      expect(updated).toContain("# Keep nested reference comment");
      expect(updated).toContain("# Keep external reference comment");
    },
  );

  it("binds copied nested aliases before a later anchor reuses their name", () => {
    const source =
      "defaults: &settings {MODE: 'old'}\nmcp_servers:\n  rea: &entry\n    command: old\n    env: *settings\nlater: &settings {MODE: 'later'}\nobserver: *entry\n";
    const result = parseHermesConfigurationYaml(
      editHermesConfigurationYaml(source, ["mcp_servers", "rea"], {
        command: "rea",
      }),
    );
    expect(result).toEqual({
      defaults: { MODE: "old" },
      mcp_servers: { rea: { command: "rea" } },
      later: { MODE: "later" },
      observer: { command: "old", env: { MODE: "old" } },
    });
  });

  it("changes only consumers of the removed definition when an anchor name repeats", () => {
    const source =
      "mcp_servers:\n  rea: &server {command: old}\n  other: *server\nlater: &server {command: later}\nobserver: *server\n";
    expect(
      parseHermesConfigurationYaml(
        editHermesConfigurationYaml(source, ["mcp_servers", "rea"], undefined),
      ),
    ).toEqual({
      mcp_servers: { other: { command: "old" } },
      later: { command: "later" },
      observer: { command: "later" },
    });
  });

  it.each([true, false])(
    "keeps shared child identity with child first=%s",
    (childFirst) => {
      const child = "child: *settings\n";
      const parent = "parent: *entry\n";
      const source =
        "mcp_servers:\n  rea: &entry\n    command: old\n    env: &settings {MODE: 'off'}\n" +
        (childFirst ? child + parent : parent + child);
      const result = parse(
        editHermesConfigurationYaml(source, ["mcp_servers", "rea"], undefined),
      );
      expect(result).toEqual({
        mcp_servers: {},
        child: { MODE: "off" },
        parent: { command: "old", env: { MODE: "off" } },
      });
      expect(result.child).toBe(result.parent.env);
    },
  );

  it("retains one source copy for repeated consumers instead of expanding every alias", () => {
    const source =
      "mcp_servers:\n  rea: &server {command: old}\nobservers:\n" +
      "  - *server\n".repeat(50);
    const updated = editHermesConfigurationYaml(
      source,
      ["mcp_servers", "rea"],
      undefined,
    );
    expect(parseHermesConfigurationYaml(updated)).toEqual({
      mcp_servers: {},
      observers: Array.from({ length: 50 }, () => ({ command: "old" })),
    });
    expect(updated.match(/command: old/gu)).toHaveLength(1);
  });

  it.each(["server", "missing"])(
    "still refuses a copied %s dependency that cannot be retained",
    (reference) => {
      const source = `mcp_servers:\n  rea: &server\n    command: old\n    dependency: *${reference}\nobserver: *server\n`;
      expect(() =>
        editHermesConfigurationYaml(source, ["mcp_servers", "rea"], undefined),
      ).toThrow();
    },
  );
});

for (const version of ["1.1", "1.2"] as const)
  it.each(["refresh", "remove"] as const)(
    `preserves YAML ${version} consumers of a replaced REA anchor during %s`,
    (operation) => {
      const original =
        `${version === "1.2" ? "%YAML 1.2\n---\n" : ""}` +
        "mcp_servers:\n  rea: &server\n    command: old-rea\n    args: [mcp]\n    env: &environment {MODE: 'on'}\n  other: *server # caller binding\nobserver: *server\nenvironment: *environment\n";
      const before = parse(original, { version });
      const updated = editHermesConfigurationYaml(
        original,
        ["mcp_servers", "rea"],
        operation === "refresh"
          ? { command: "new-rea", args: ["mcp"] }
          : undefined,
      );
      expect(parse(updated, { version })).toEqual({
        mcp_servers: {
          ...(operation === "refresh"
            ? { rea: { command: "new-rea", args: ["mcp"] } }
            : {}),
          other: before.mcp_servers.other,
        },
        observer: before.observer,
        environment: before.environment,
      });
      expect(updated).toContain("# caller binding");
      expect(
        editHermesConfigurationYaml(
          updated,
          ["mcp_servers", "rea"],
          operation === "refresh"
            ? { command: "new-rea", args: ["mcp"] }
            : undefined,
        ),
      ).toBe(updated);
    },
  );

describe("Hermes YAML deletion", () => {
  for (const version of ["1.1", "1.2"] as const) {
    for (const [name, body, path] of [
      [
        "an aliased table",
        "server_defaults: &servers\n  other:\n    command: other-server\n\nmcp_servers: *servers # Selected table\n",
        ["mcp_servers", "rea"],
      ],
      [
        "nested aliases",
        "defaults: &defaults\n  other: {command: other-server}\nservers: &servers\n  mcp_servers: *defaults\nclient: *servers\nobserver: *servers\n",
        ["client", "mcp_servers", "rea"],
      ],
      [
        "shadowed anchors",
        "first: &server {command: original}\ndefaults: &servers\n  other: *server\nsecond: &server {command: replacement}\nmcp_servers: *servers\nobserver: *server\n",
        ["mcp_servers", "rea"],
      ],
      [
        "shared consumers",
        "defaults: &servers\n  other: &other {command: other-server}\nmcp_servers: *servers\nobserver: *servers\nother_observer: *other\n",
        ["mcp_servers", "rea"],
      ],
      [
        "an explicit flow table with CRLF",
        "# Keep formatting\r\nmcp_servers: {other: {command: other-server}}\r\n",
        ["mcp_servers", "rea"],
      ],
    ] as const) {
      it(`preserves YAML ${version} bytes when deleting an absent key from ${name}`, () => {
        const source = (version === "1.2" ? "%YAML 1.2\n---\n" : "") + body;
        expect(editHermesConfigurationYaml(source, path, undefined)).toBe(
          source,
        );
      });
    }
  }

  for (const [name, reference] of [
    ["cyclic", "servers"],
    ["unresolved", "missing"],
  ]) {
    it(`still refuses deletion through a table containing a ${name} alias`, () => {
      const source = `defaults: &servers\n  rea: {command: rea}\n  other: *${reference}\nmcp_servers: *servers\n`;
      expect(() =>
        editHermesConfigurationYaml(source, ["mcp_servers", "rea"], undefined),
      ).toThrow(TypeError);
    });
  }
});

describe("Hermes configuration YAML", () => {
  it("retains a quoted sequence element when replacing its registration", () => {
    const source =
      "mcp_servers:\n  rea:\n    command: old\n    args:\n      - 'mcp'\n";
    expect(
      editHermesConfigurationYaml(source, ["mcp_servers", "rea"], {
        command: "rea",
        args: ["mcp"],
      }),
    ).toBe(source.replace("command: old", "command: rea"));
  });

  it("retains explicit string tags on unchanged keys and values", () => {
    const source =
      "%YAML 1.2\n---\nmcp_servers:\n  rea:\n    command: old\n    env:\n      !!str ON: !!str off\n";
    const written = editHermesConfigurationYaml(
      source,
      ["mcp_servers", "rea"],
      {
        command: "rea",
        env: { ON: "off" },
      },
    );
    expect(written).toBe(source.replace("command: old", 'command: "rea"'));
    expect(
      parse(written.slice("%YAML 1.2\n---\n".length), { version: "1.1" }),
    ).toMatchObject({ mcp_servers: { rea: { env: { ON: "off" } } } });
  });

  it("writes an edited number from its new value", () => {
    expect(
      editHermesConfigurationYaml("mode: 0600\nmask: 0x1F\n", ["mode"], 420),
    ).toBe("mode: 0644\nmask: 0x1F\n");
  });

  it("accepts keys Hermes reads as distinct and rejects a repeated key", () => {
    expect(() =>
      parseHermesConfigurationYaml("0600: octal\n600: decimal\n"),
    ).not.toThrow();
    expect(() => parseHermesConfigurationYaml('a: 1\n"a": 2\n')).toThrow();
    expect(() => parseHermesConfigurationYaml("yes: 1\ntrue: 2\n")).toThrow();
    expect(() => parseHermesConfigurationYaml("no: 1\noff: 2\n")).toThrow();
  });

  it("matches Hermes numeric key equality without losing large integer precision", () => {
    for (const text of [
      "1: first\n01: second\n",
      "1.0: first\n1.00: second\n",
      "true: first\n1: second\n",
      "false: first\n0.0: second\n",
      ".nan: first\n.NAN: second\n",
      "9007199254740992: first\n9007199254740992.0: second\n",
    ])
      expect(() => parseHermesConfigurationYaml(text)).toThrow();

    expect(() =>
      parseHermesConfigurationYaml(
        "9007199254740992: first\n9007199254740993: second\n",
      ),
    ).not.toThrow();
    expect(() =>
      parseHermesConfigurationYaml(
        "9007199254740993: first\n9007199254740993.0: second\n",
      ),
    ).not.toThrow();
    expect(() =>
      parseHermesConfigurationYaml("0600: octal\n600: decimal\n"),
    ).not.toThrow();
    expect(parseHermesConfigurationYaml("value: 9007199254740993\n")).toEqual({
      value: 9007199254740993n,
    });
  });

  it("matches Hermes timestamp key precision, timezone, and date-type equality", () => {
    for (const text of [
      "2026-10-14T00:00:00.123456+08:00: first\n2026-10-13T16:00:00.123456Z: second\n",
      "2026-10-14T00:00:00.1234565Z: first\n2026-10-14T00:00:00.123457Z: second\n",
    ])
      expect(() => parseHermesConfigurationYaml(text)).toThrow();

    expect(() =>
      parseHermesConfigurationYaml(
        "2026-10-14T00:00:00.123456Z: first\n2026-10-14T00:00:00.123457Z: second\n",
      ),
    ).not.toThrow();
    expect(() =>
      parseHermesConfigurationYaml(
        "2026-10-14: date\n2026-10-14T00:00:00Z: timestamp\n",
      ),
    ).not.toThrow();
    expect(() =>
      parseHermesConfigurationYaml(
        "2026-10-14T00:00:00: local\n2026-10-14T00:00:00Z: utc\n",
      ),
    ).not.toThrow();
  });

  it("matches Hermes timestamp resolution and rejects invalid calendar values", () => {
    expect(parseHermesConfigurationYaml("short: 2026-1-1\n")).toEqual({
      short: "2026-1-1",
    });
    expect(
      parseHermesConfigurationYaml("short: 2026-1-1 1:02:03.\n"),
    ).toMatchObject({ short: expect.any(Date) });
    expect(
      parseHermesConfigurationYaml("short: 2026-01-01 1:02:03\n"),
    ).toMatchObject({ short: expect.any(Date) });
    expect(parseHermesConfigurationYaml("short: 2026-01-01 1:2:03\n")).toEqual({
      short: "2026-01-01 1:2:03",
    });
    expect(parseHermesConfigurationYaml("short: 2026-01-01 1:02:3\n")).toEqual({
      short: "2026-01-01 1:02:3",
    });
    const firstYear = parseHermesConfigurationYaml("date: 0001-01-01\n") as {
      date: Date;
    };
    expect(firstYear.date.getUTCFullYear()).toBe(1);
    expect(
      parseHermesConfigurationYaml("date: 1969-12-31T23:59:59.999999Z\n"),
    ).toEqual({ date: new Date("1969-12-31T23:59:59.999Z") });

    for (const invalid of [
      "date: 0000-01-01\n",
      "date: 2026-02-30\n",
      "date: 2026-01-01 24:00:00\n",
      "date: 2026-01-01 00:00:00+24\n",
      "date: 9999-12-31T23:59:59.9999995Z\n",
    ])
      expect(() => parseHermesConfigurationYaml(invalid)).toThrow();
  });

  it("preserves YAML 1.1 strings on fresh files and honors directives on edits", () => {
    const created = stringifyHermesConfigurationYaml({
      mcp_servers: { rea: { env: { PROFILE: "off" } } },
    });
    expect(parse(created, { version: "1.1" })).toMatchObject({
      mcp_servers: { rea: { env: { PROFILE: "off" } } },
    });

    const original =
      "%YAML 1.2\n---\nnotify: on\ntimestamp: 2026-10-14T00:00:00.123456+08:00\n";
    const updated = editHermesConfigurationYaml(original, ["environment"], {
      SETTING: "off",
      DATE: "2026-10-14",
    });
    expect(updated.startsWith(original)).toBe(true);
    expect(parse(updated)).toMatchObject({
      notify: "on",
      environment: { SETTING: "off", DATE: "2026-10-14" },
    });
    expect(
      parseHermesConfigurationYaml("%YAML 1.2\n---\ndate: 2026-10-14\n"),
    ).toEqual({ date: new Date("2026-10-14") });
  });
});

it("retains exact integer settings through a parsed Hermes launcher refresh", () => {
  const source =
    "mcp_servers:\n  rea:\n    command: old\n    identifier: 9007199254740993 # caller identifier\n    negative: -9007199254740993\n    safe: 9007199254740991\n    mode: 0600\n";
  const parsed = parseClientConfiguration(source, "hermes");
  const previous = parsed.servers.rea as Record<string, unknown>;
  const result = serializeClientConfiguration(
    withClientServers(parsed, {
      ...parsed.servers,
      rea: { ...previous, command: "rea" },
    }),
    "hermes",
    source,
  );
  if (!result.ok) throw new Error("Hermes edit was refused");
  expect(result.value).toBe(source.replace("command: old", "command: rea"));
  expect(parse(result.value, { version: "1.1", intAsBigInt: true })).toEqual({
    mcp_servers: {
      rea: {
        command: "rea",
        identifier: 9007199254740993n,
        negative: -9007199254740993n,
        safe: 9007199254740991n,
        mode: 384n,
      },
    },
  });
});

it("keeps argument annotations with unique values and retains removed annotations on the list", () => {
  const source =
    "mcp_servers:\n  rea:\n    args:\n      - mcp # mcp note\n      - old # removed note\n      - dup # first duplicate\n      - dup # second duplicate\n";
  const updated = editHermesConfigurationYaml(source, ["mcp_servers", "rea"], {
    args: ["script", "mcp", "dup"],
  });
  expect(parseHermesConfigurationYaml(updated)).toEqual({
    mcp_servers: { rea: { args: ["script", "mcp", "dup"] } },
  });
  expect(updated).toMatch(/- mcp # mcp note/u);
  expect(updated).not.toMatch(/- script # mcp note/u);
  for (const comment of [
    "mcp note",
    "removed note",
    "first duplicate",
    "second duplicate",
  ])
    expect(updated.split(comment)).toHaveLength(2);
});

describe("Hermes registration refresh around anchors and merges", () => {
  it("keeps an alias's value when an earlier same-name anchor would capture it", () => {
    const source =
      "defaults: &launcher /other/rea\nmcp_servers:\n  rea:\n    command: &launcher /old/rea\n    env: {REA_LAUNCHER: *launcher}\n";
    const out = editHermesConfigurationYaml(source, ["mcp_servers", "rea"], {
      command: "/new/rea",
      env: { REA_LAUNCHER: "/old/rea" },
    });
    expect(parseHermesConfigurationYaml(out)).toMatchObject({
      defaults: "/other/rea",
      mcp_servers: {
        rea: { command: "/new/rea", env: { REA_LAUNCHER: "/old/rea" } },
      },
    });
  });

  it("keeps the comment on an alias the refresh materializes", () => {
    const source =
      "mcp_servers:\n  rea:\n    command: &launcher /old/rea\n    env:\n      REA_LAUNCHER: *launcher # explanation\n";
    const out = editHermesConfigurationYaml(source, ["mcp_servers", "rea"], {
      command: "/new/rea",
      env: { REA_LAUNCHER: "/old/rea" },
    });
    expect(out).toContain("# explanation");
    expect(parseHermesConfigurationYaml(out)).toMatchObject({
      mcp_servers: { rea: { env: { REA_LAUNCHER: "/old/rea" } } },
    });
  });

  it("keeps an alias to a sibling anchor that survives the refresh", () => {
    const source =
      "mcp_servers:\n  rea:\n    command: old\n    setting: &setting keep\n    metadata: {nested: *setting}\n";
    const out = editHermesConfigurationYaml(source, ["mcp_servers", "rea"], {
      command: "new",
      setting: "keep",
      metadata: { nested: "keep" },
    });
    expect(out).toContain("nested: *setting");
    expect(
      parseHermesConfigurationYaml(
        out.replace("&setting keep", "&setting changed"),
      ),
    ).toMatchObject({
      mcp_servers: { rea: { metadata: { nested: "changed" } } },
    });
  });
});

describe("Hermes registration refresh through inherited merges", () => {
  it("refuses to drop locally overridden settings that its merge would restore", () => {
    const source =
      "remote: &remote\n  url: https://example.invalid\n  transport: sse\nmcp_servers:\n  rea:\n    <<: *remote\n    url: https://local.invalid\n    transport: sse\n";
    expect(() =>
      editHermesConfigurationYaml(source, ["mcp_servers", "rea"], {
        command: "rea",
        args: ["mcp"],
      }),
    ).toThrow(/Cannot remove inherited YAML setting/);
  });

  it("replaces an inherited remote registration without its remote selectors", () => {
    const source =
      "shared: &shared\n  rea: {url: https://example.invalid, transport: sse}\nmcp_servers:\n  <<: *shared\n";
    const out = editHermesConfigurationYaml(source, ["mcp_servers", "rea"], {
      command: "rea",
      args: ["mcp"],
    });
    const parsed = parseHermesConfigurationYaml(out) as {
      mcp_servers: { rea: Record<string, unknown> };
    };
    expect(parsed.mcp_servers.rea).toEqual({ command: "rea", args: ["mcp"] });
  });

  it("refuses to edit a field whose aliased and plain keys name the same setting", () => {
    const source =
      "field: &field env\nmcp_servers:\n  rea:\n    command: rea\n    *field : {A: first}\n    env: {A: second}\n";
    expect(() =>
      editHermesConfigurationYaml(source, ["mcp_servers", "rea"], {
        command: "rea",
        env: { A: "third" },
      }),
    ).toThrow(/env/);
  });

  it("edits a field whose key is an alias to a shared string, keeping the alias", () => {
    const source =
      "field: &field env\nmcp_servers:\n  rea:\n    command: rea\n    *field : {A: '1'}\n";
    const out = editHermesConfigurationYaml(source, ["mcp_servers", "rea"], {
      command: "rea",
      env: { A: "2" },
    });
    expect(out).toContain("*field");
    expect(parseHermesConfigurationYaml(out)).toMatchObject({
      field: "env",
      mcp_servers: { rea: { command: "rea", env: { A: "2" } } },
    });
  });

  it("writes a plain key when an aliased key's anchor is rebuilt by the same edit", () => {
    const source =
      "mcp_servers:\n  rea:\n    command: &field env\n    *field : {A: '1'}\n";
    const out = editHermesConfigurationYaml(source, ["mcp_servers", "rea"], {
      command: "rea",
      env: { A: "2" },
    });
    expect(out).not.toContain("*field");
    expect(parseHermesConfigurationYaml(out)).toMatchObject({
      mcp_servers: { rea: { command: "rea", env: { A: "2" } } },
    });
  });

  it("materializes an alias whose sibling anchor the refresh replaces", () => {
    const source =
      "mcp_servers:\n  rea:\n    command: &launcher /old/rea\n    env: {REA_LAUNCHER: *launcher}\n";
    const out = editHermesConfigurationYaml(source, ["mcp_servers", "rea"], {
      command: "/new/rea",
      env: { REA_LAUNCHER: "/old/rea" },
    });
    expect(parseHermesConfigurationYaml(out)).toMatchObject({
      mcp_servers: {
        rea: { command: "/new/rea", env: { REA_LAUNCHER: "/old/rea" } },
      },
    });
  });

  it("materializes an alias to an anchor moved to an outside consumer", () => {
    const source =
      "mcp_servers:\n  rea:\n    command: rea\n    setting: &setting keep\n    metadata: {nested: *setting}\nobserver: *setting\n";
    const out = editHermesConfigurationYaml(source, ["mcp_servers", "rea"], {
      command: "rea2",
      setting: "changed",
      metadata: { nested: "keep" },
    });
    expect(parseHermesConfigurationYaml(out)).toMatchObject({
      observer: "keep",
      mcp_servers: {
        rea: { setting: "changed", metadata: { nested: "keep" } },
      },
    });
  });

  it("keeps an inherited stdio transport through a launcher refresh", () => {
    const source =
      "defaults: &defaults\n  transport: stdio\n  command: rea\n  args: [mcp]\nmcp_servers:\n  rea:\n    <<: *defaults\n";
    const client = supportedClients("/home/rea-test").find(
      ({ name }) => name === "hermes",
    )!;
    const parsed = parseClientConfiguration(source, "hermes");
    const registration = refreshClientRegistration(
      client,
      "hermes",
      ["rea", "mcp"],
      { A: "1" },
      effectiveClientServer(parsed, "rea"),
      {
        analysisProvider: "auto",
        ghidraStartupTimeoutMs: 1,
        hopperStartupTimeoutMs: 1,
      },
    );
    if (!registration.ok) throw registration.error;
    const written = serializeClientConfiguration(
      withClientServers(parsed, { ...parsed.servers, rea: registration.value }),
      "hermes",
      source,
    );
    if (!written.ok) throw written.error;
    expect(written.value).toContain("<<: *defaults");
    expect(parseHermesConfigurationYaml(written.value)).toMatchObject({
      mcp_servers: {
        rea: { transport: "stdio", command: "rea", env: { A: "1" } },
      },
    });
  });

  it("overrides an inherited registration with only its changed fields", () => {
    const source =
      "shared: &shared\n  rea: {command: rea, metadata: {marker: old}}\nmcp_servers:\n  <<: *shared\n";
    const out = editHermesConfigurationYaml(source, ["mcp_servers", "rea"], {
      command: "rea",
      metadata: { marker: "old" },
      env: { A: "1" },
    });
    const changed = out.replace("marker: old", "marker: new");
    expect(parseHermesConfigurationYaml(changed)).toMatchObject({
      mcp_servers: { rea: { metadata: { marker: "new" }, env: { A: "1" } } },
    });
  });
});
