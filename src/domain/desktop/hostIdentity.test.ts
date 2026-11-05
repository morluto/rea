import { describe, expect, it } from "vitest";

import {
  SEED_HOME,
  hostIdentityIn,
  scrubHostIdentity,
  scrubSeed,
  type HostIdentity,
} from "./hostIdentity.js";

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

describe("scrubHostIdentity", () => {
  it("replaces user@host, keeping a short user name standing alone", () => {
    expect(
      scrubHostIdentity(
        "pref_template_mail=ada@e81232be457d\npref_template_developer=ada\nby ada@example.com\n",
        GEANY,
      ),
    ).toBe(
      "pref_template_mail=user@localhost\npref_template_developer=ada\nby ada@example.com\n",
    );
  });

  it("replaces the host name only as a whole name, not inside a word or a domain", () => {
    expect(
      scrubHostIdentity(
        "host=e81232be457d\non e81232be457d.\nhttp://e81232be457d.local/\nxe81232be457d e81232be457d-2\n",
        GEANY,
      ),
    ).toBe(
      "host=localhost\non localhost.\nhttp://e81232be457d.local/\nxe81232be457d e81232be457d-2\n",
    );
    const ubuntu = { home: "/home/ubuntu", hostname: "ubuntu", user: "user" };
    expect(
      scrubHostIdentity(
        "deb http://ports.ubuntu.com/ubuntu-ports noble\nuser settings\n",
        ubuntu,
      ),
    ).toBe("deb http://ports.ubuntu.com/ubuntu-ports noble\nuser settings\n");
  });

  it("replaces the home path where a whole path segment ends after it", () => {
    expect(
      scrubHostIdentity(
        "a=/home/ada/Documents/x\nb=file:///home/ada\nc=/home/adam/x\nd=/home/ada.bak\n",
        GEANY,
      ),
    ).toBe(
      `a=${SEED_HOME}/Documents/x\nb=file://${SEED_HOME}\nc=/home/adam/x\nd=/home/ada.bak\n`,
    );
  });

  it("replaces only the home when the capture recorded no host name or user", () => {
    expect(
      scrubHostIdentity("/home/ada/x ada@e81232be457d e81232be457d", {
        home: "/home/ada",
        hostname: null,
        user: null,
      }),
    ).toBe(`${SEED_HOME}/x ada@e81232be457d e81232be457d`);
  });
});

describe("hostIdentityIn", () => {
  it("names the first spelling of the identity a text holds, and none for the user name alone", () => {
    expect(hostIdentityIn('["mail=ada@e81232be457d"]', GEANY)).toBe(
      "ada@e81232be457d",
    );
    expect(hostIdentityIn('["e81232be457d"]', GEANY)).toBe("e81232be457d");
    expect(hostIdentityIn('["author=ada"]', GEANY)).toBeUndefined();
    expect(
      hostIdentityIn("localhost", { ...GEANY, hostname: "localhost" }),
    ).toBeUndefined();
  });
});

const hex = (bytes: Buffer | undefined) => bytes?.toString("hex");

describe("scrubSeed", () => {
  it("rewrites a UTF-8 text seed, keeping its byte-order mark, and leaves a clean one as it is", () => {
    const scrubbed = scrubSeed(
      Buffer.from("\uFEFFmail=ada@e81232be457d\n"),
      true,
      GEANY,
    );

    expect(hex(scrubbed.bytes)).toBe(
      hex(Buffer.from("\uFEFFmail=user@localhost\n")),
    );
    expect(scrubbed.holdsIdentity).toBe(false);
    expect(scrubSeed(Buffer.from("wrap=true\n"), true, GEANY)).toEqual({
      bytes: undefined,
      holdsIdentity: false,
    });
  });

  it.each(["le", "be"] as const)(
    "rewrites a UTF-16 %s seed with a byte-order mark in its own order",
    (order) => {
      const scrubbed = scrubSeed(
        utf16("20260216;/home/ada/.varicad;ada@e81232be457d\n", order),
        false,
        GEANY,
      );

      expect(hex(scrubbed.bytes)).toBe(
        hex(utf16(`20260216;${SEED_HOME}/.varicad;user@localhost\n`, order)),
      );
    },
  );

  it("reports a seed whose shipped bytes still hold the host name or the captured home", () => {
    const database = Buffer.concat([
      Buffer.from("SQLite format 3\0"),
      Buffer.from([0, 1, 2]),
      Buffer.from("e81232be457d"),
    ]);
    const outcomes = [
      scrubSeed(database, false, GEANY),
      scrubSeed(Buffer.from("url=http://e81232be457d.local/\n"), true, GEANY),
      scrubSeed(Buffer.from("SQLite format 3\0ada"), false, GEANY),
      scrubSeed(Buffer.from([0xff, 0xfe, 0x41]), false, GEANY),
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
      scrubSeed(Buffer.from(`SQLite format 3\0${SEED_HOME}/x`), false, inside),
    ).toEqual({ bytes: undefined, holdsIdentity: false });
    expect(scrubHostIdentity(`${SEED_HOME}/x user@4f0c1d2e3a4b`, inside)).toBe(
      `${SEED_HOME}/x user@localhost`,
    );
  });
});
