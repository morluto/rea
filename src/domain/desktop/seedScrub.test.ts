import { describe, expect, it } from "vitest";

import { SEED_HOME, type HostIdentity } from "./hostIdentity.js";
import { scrubDconf, scrubSeed } from "./seedScrub.js";
import { detectStateFormat } from "./stateFormats.js";

const GEANY: HostIdentity = {
  home: "/home/ada",
  hostname: "e81232be457d",
  user: "ada",
};

/** Text as UTF-16 after a byte-order mark, in either byte order. */
const utf16 = (text: string, order: "le" | "be") => {
  const bytes = Buffer.from(`\uFEFF${text}`, "utf16le");
  return order === "be" ? bytes.swap16() : bytes;
};

/** A seed at a home path that says nothing of its format. */
const seed = (format: string) => ({ home: "seed", format });

const scrubbed = (text: string, format: string, identity = GEANY) => {
  const outcome = scrubSeed(Buffer.from(text), seed(format), identity);
  return {
    text: outcome.bytes?.toString("utf8"),
    holdsIdentity: outcome.holdsIdentity,
  };
};

describe("scrubSeed on text", () => {
  it("rewrites a UTF-8 text seed, keeping its byte-order mark, and leaves a clean one as it is", () => {
    expect(scrubbed("\uFEFFmail=ada@e81232be457d\n", "keyfile")).toEqual({
      text: "\uFEFFmail=user@localhost\n",
      holdsIdentity: false,
    });
    expect(scrubbed("wrap=true\n", "text")).toEqual({
      text: undefined,
      holdsIdentity: false,
    });
  });

  it.each(["le", "be"] as const)(
    "rewrites a UTF-16 %s seed with a byte-order mark in its own order",
    (order) => {
      const outcome = scrubSeed(
        utf16("20260216;/home/ada/.varicad;ada@e81232be457d\n", order),
        seed("binary"),
        GEANY,
      );

      expect(outcome.bytes?.toString("hex")).toBe(
        utf16(
          `20260216;${SEED_HOME}/.varicad;user@localhost\n`,
          order,
        ).toString("hex"),
      );
    },
  );

  it("replaces the captured user@localhost of a host named localhost and finds it in bytes it cannot rewrite", () => {
    const local = { ...GEANY, hostname: "localhost" };

    expect(scrubbed("mail=ada@localhost\n", "keyfile", local)).toEqual({
      text: "mail=user@localhost\n",
      holdsIdentity: false,
    });
    expect(scrubbed("SQLite format 3\0ada@localhost", "sqlite", local)).toEqual(
      { text: undefined, holdsIdentity: true },
    );
  });
});

describe("scrubSeed on JSON and XML", () => {
  it("rewrites JSON strings only, so a host named like a literal leaves the syntax valid", () => {
    const named = { ...GEANY, hostname: "true" };
    const outcome = scrubbed(
      '{"enabled": true, "host": "true", "list": [true, "a true"]}',
      "json",
      named,
    );

    expect(outcome.text).toBe(
      '{"enabled": true, "host": "localhost", "list": [true, "a localhost"]}',
    );
    expect(JSON.parse(outcome.text ?? "")).toEqual({
      enabled: true,
      host: "localhost",
      list: [true, "a localhost"],
    });
  });

  it("keeps member names, reporting one that holds the host rather than rewriting it into another", () => {
    const named = { ...GEANY, hostname: "ubuntu" };
    const text = String.raw`{"ubuntu": 1, "localhost": 2, "\u0075buntu-dock"
      : "ubuntu", "list": ["ubuntu"]}`;

    const outcome = scrubbed(text, "json", named);

    expect(outcome).toEqual({
      text: String.raw`{"ubuntu": 1, "localhost": 2, "\u0075buntu-dock"
      : "localhost", "list": ["localhost"]}`,
      holdsIdentity: true,
    });
    expect(Object.keys(JSON.parse(outcome.text ?? "") as object)).toEqual([
      "ubuntu",
      "localhost",
      "ubuntu-dock",
      "list",
    ]);
  });

  it("walks a JSON string of 16,000,000 characters, which the capture can retain, without running out of stack", () => {
    const note = "x".repeat(16_000_000);
    const text = `{"note": "${note}", "mail": "ada@e81232be457d"}`;

    const outcome = scrubSeed(Buffer.from(text), seed("json"), GEANY);

    expect(outcome.holdsIdentity).toBe(false);
    expect(outcome.bytes?.length).toBe(text.length - 2);
    expect(outcome.bytes?.subarray(-29).toString("utf8")).toBe(
      `x", "mail": "user@localhost"}`,
    );
  });

  it("decodes JSON escapes, rewriting an escaped identity and finding one left inside a domain", () => {
    expect(
      scrubbed(
        String.raw`{"mail": "ada@\u006581232be457d", "kept": "\u00e9"}`,
        "json",
      ),
    ).toEqual({
      text: String.raw`{"mail": "user@localhost", "kept": "\u00e9"}`,
      holdsIdentity: false,
    });
    expect(
      scrubbed(String.raw`{"url": "http://\u006581232be457d.local/"}`, "json"),
    ).toEqual({ text: undefined, holdsIdentity: true });
  });

  it("rewrites XML text, attribute values, comments and CDATA but not names, decoding references", () => {
    const xml = `<?xml version="1.0"?>\n<m a="ada@&#x65;81232be457d" b='x &amp; y'>ada&#64;e81232be457d<!-- by ada@e81232be457d --><![CDATA[/home/ada/x]]></m>`;
    const named = { ...GEANY, hostname: "item" };

    const outcome = scrubbed(xml, "xml");
    const items = scrubbed('<item kind="item">item</item>', "xml", named);

    expect(outcome).toEqual({
      text: `<?xml version="1.0"?>\n<m a="user@localhost" b='x &amp; y'>user@localhost<!-- by user@localhost --><![CDATA[${SEED_HOME}/x]]></m>`,
      holdsIdentity: false,
    });
    expect(detectStateFormat("m.xml", Buffer.from(outcome.text ?? ""))).toBe(
      "xml",
    );
    expect(items.text).toBe('<item kind="localhost">localhost</item>');
  });

  it.each(["le", "be"] as const)(
    "scrubs UTF-16 %s JSON and XML by value, as their UTF-8 forms are, in their own byte order",
    (order) => {
      const named = { ...GEANY, hostname: "ubuntu" };
      const json = '{"ubuntu": 1, "localhost": 2, "dock": "ubuntu"}';
      const xml = `<?xml version="1.0" encoding="UTF-16"?>\n<ubuntu a="ubuntu">ubuntu</ubuntu>`;

      const outcomes = [
        { text: json, home: ".config/dock.json" },
        { text: xml, home: ".config/dock.xml" },
      ].map(({ text, home }) =>
        scrubSeed(utf16(text, order), { home, format: "binary" }, named),
      );

      expect(
        outcomes.map(({ bytes, holdsIdentity }) => [
          bytes?.toString("hex"),
          holdsIdentity,
        ]),
      ).toEqual([
        [
          utf16(
            '{"ubuntu": 1, "localhost": 2, "dock": "localhost"}',
            order,
          ).toString("hex"),
          true,
        ],
        [
          utf16(
            `<?xml version="1.0" encoding="UTF-16"?>\n<ubuntu a="localhost">localhost</ubuntu>`,
            order,
          ).toString("hex"),
          true,
        ],
      ]);
    },
  );

  it("finds an identity XML references hide inside a domain, which it does not rewrite", () => {
    expect(scrubbed("<m>http://&#x65;81232be457d.local/</m>", "xml")).toEqual({
      text: undefined,
      holdsIdentity: true,
    });
  });

  it("scrubs around a reference past the last code point instead of throwing", () => {
    const outcome = scrubbed(
      '<m a="&#x110000;">&#1114112; ada@e81232be457d</m>',
      "xml",
    );
    expect(outcome.holdsIdentity).toBe(false);
    expect(outcome.text).toContain("user@localhost");
    expect(outcome.text).not.toContain("e81232be457d");
  });
});

describe("scrubSeed XML value preservation", () => {
  it.each(["\n", "\t", "\r", "\r\n"])(
    "keeps normalized attribute whitespace when replacing the home (%j)",
    (space) => {
      expect(
        scrubbed(
          `<m path="/home/ada/a${space} b" kept='a${space}b' referenced="/home/ada/a&#10;&#9;&#13;b"/>`,
          "xml",
        ),
      ).toEqual({
        text: `<m path="${SEED_HOME}/a  b" kept='a${space}b' referenced="${SEED_HOME}/a&#10;&#9;&#13;b"/>`,
        holdsIdentity: false,
      });
    },
  );

  it.each(["\r\n", "\r"])(
    "keeps normalized character data and explicit references (%j)",
    (ending) => {
      expect(scrubbed(`<m>/home/ada/a${ending} b&#13;c\t</m>`, "xml")).toEqual({
        text: `<m>${SEED_HOME}/a\n b&#13;c\t</m>`,
        holdsIdentity: false,
      });
    },
  );

  it("keeps all bytes when no XML value holds the identity", () => {
    expect(scrubbed('<m path="a\r\n b\tc">a\r\n b&#13;c</m>', "xml")).toEqual({
      text: undefined,
      holdsIdentity: false,
    });
  });

  it.each(["le", "be"] as const)(
    "preserves the same XML values and source byte order in UTF-16 %s",
    (order) => {
      const input = `<?xml version="1.0" encoding="UTF-16"?><m path="/home/ada/a\r\n b">/home/ada/a\r\nb&#13;c</m>`;
      const expected = `<?xml version="1.0" encoding="UTF-16"?><m path="${SEED_HOME}/a  b">${SEED_HOME}/a\nb&#13;c</m>`;
      const result = scrubSeed(
        utf16(input, order),
        { home: "settings.xml", format: "binary" },
        GEANY,
      );
      expect(result.bytes?.equals(utf16(expected, order))).toBe(true);
      expect(result.holdsIdentity).toBe(false);
    },
  );
});

describe("scrubSeed on bytes it does not rewrite", () => {
  it("reports a seed whose shipped bytes still hold the host name or the captured home", () => {
    const database = Buffer.concat([
      Buffer.from("SQLite format 3\0"),
      Buffer.from([0, 1, 2]),
      Buffer.from("e81232be457d"),
    ]);
    const outcomes = [
      scrubSeed(database, seed("sqlite"), GEANY),
      scrubSeed(
        Buffer.from("url=http://e81232be457d.local/\n"),
        seed("text"),
        GEANY,
      ),
      scrubSeed(Buffer.from("SQLite format 3\0ada"), seed("sqlite"), GEANY),
      scrubSeed(Buffer.from([0xff, 0xfe, 0x41]), seed("binary"), GEANY),
    ];

    expect(
      outcomes.map(({ bytes, holdsIdentity }) => [bytes, holdsIdentity]),
    ).toEqual([
      [undefined, true],
      [undefined, true],
      [undefined, false],
      [undefined, false],
    ]);
  });

  it("leaves the seed's own home alone, as a capture inside the computer spells it", () => {
    const inside = { home: SEED_HOME, hostname: "4f0c1d2e3a4b", user: "user" };

    expect(
      scrubSeed(
        Buffer.from(`SQLite format 3\0${SEED_HOME}/x`),
        seed("sqlite"),
        inside,
      ),
    ).toEqual({ bytes: undefined, holdsIdentity: false });
    expect(
      scrubbed(`${SEED_HOME}/x user@4f0c1d2e3a4b`, "text", inside),
    ).toEqual({ text: `${SEED_HOME}/x user@localhost`, holdsIdentity: false });
  });
});

describe("scrubDconf", () => {
  const named = { ...GEANY, hostname: "true" };

  it("rewrites GVariant strings by their decoded values, keeping groups, keys, dictionary keys, literals and bytestrings", () => {
    const outcome = scrubDconf(
      {
        "org/true": {
          true: "true",
          mail: String.raw`'ada@\u0074rue'`,
          quoted: `"it's true"`,
          list: "['true', \"a 'true'\", 'x']",
          hosts: "{'true': <'true'>}",
          blob: "b'true'",
          count: "uint32 7",
        },
      },
      named,
    );

    expect(outcome.text).toBe(
      [
        "[org/true]",
        "true=true",
        "mail='user@localhost'",
        `quoted="it's localhost"`,
        "list=['localhost', \"a 'localhost'\", 'x']",
        "hosts={'true': <'localhost'>}",
        "blob=b'true'",
        "count=uint32 7",
        "",
      ].join("\n"),
    );
    expect(outcome.holdsIdentity).toBe(true);
  });

  it("escapes what a rewritten string holds that would end it or its line", () => {
    const outcome = scrubDconf(
      { "org/notes": { note: String.raw`'true\nit\'s \\ true'` } },
      named,
    );

    expect(outcome.text).toBe(
      String.raw`[org/notes]
note='localhost\u000ait\'s \\ localhost'
`,
    );
  });

  it.each([
    ["an unterminated string", "'ada@e81232be457d"],
    ["an escape naming no character", String.raw`'ada@e81232be457d\u0000'`],
    ["an object path", "[objectpath '/e81232be457d', '/x']"],
    ["a signature", "@mg 'e81232be457d'"],
  ])(
    "keeps a value holding %s as captured and finds the host in it",
    (_name, value) => {
      expect(scrubDconf({ "org/notes": { key: value } }, GEANY)).toEqual({
        text: `[org/notes]\nkey=${value}\n`,
        holdsIdentity: true,
      });
    },
  );

  it("finds a host its escapes spell where the scrub does not replace it", () => {
    expect(
      scrubDconf(
        { "org/notes": { url: String.raw`'http://\u006581232be457d.local/'` } },
        GEANY,
      ),
    ).toEqual({
      text: String.raw`[org/notes]
url='http://\u006581232be457d.local/'
`,
      holdsIdentity: true,
    });
  });
});
