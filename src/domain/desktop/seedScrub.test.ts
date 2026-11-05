import { describe, expect, it } from "vitest";

import { SEED_HOME, type HostIdentity } from "./hostIdentity.js";
import { scrubSeed } from "./seedScrub.js";
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

const scrubbed = (text: string, format: string, identity = GEANY) => {
  const outcome = scrubSeed(Buffer.from(text), format, identity);
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
        "binary",
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

describe("scrubSeed on bytes it does not rewrite", () => {
  it("reports a seed whose shipped bytes still hold the host name or the captured home", () => {
    const database = Buffer.concat([
      Buffer.from("SQLite format 3\0"),
      Buffer.from([0, 1, 2]),
      Buffer.from("e81232be457d"),
    ]);
    const outcomes = [
      scrubSeed(database, "sqlite", GEANY),
      scrubSeed(Buffer.from("url=http://e81232be457d.local/\n"), "text", GEANY),
      scrubSeed(Buffer.from("SQLite format 3\0ada"), "sqlite", GEANY),
      scrubSeed(Buffer.from([0xff, 0xfe, 0x41]), "binary", GEANY),
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
        "sqlite",
        inside,
      ),
    ).toEqual({ bytes: undefined, holdsIdentity: false });
    expect(
      scrubbed(`${SEED_HOME}/x user@4f0c1d2e3a4b`, "text", inside),
    ).toEqual({ text: `${SEED_HOME}/x user@localhost`, holdsIdentity: false });
  });
});
