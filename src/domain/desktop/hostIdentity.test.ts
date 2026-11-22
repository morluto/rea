import { describe, expect, it } from "vitest";

import {
  SEED_HOME,
  identityLeftIn,
  scrubHostIdentity,
  type HostIdentity,
} from "./hostIdentity.js";

const GEANY: HostIdentity = {
  home: "/home/ada",
  hostname: "e81232be457d",
  user: "ada",
};

/** A capture whose host is named localhost, so only user@host gives it away. */
const LOCAL: HostIdentity = { ...GEANY, hostname: "localhost" };

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

describe("scrubHostIdentity on a host named localhost", () => {
  it("replaces the captured user@localhost and leaves localhost alone", () => {
    expect(
      scrubHostIdentity("mail=ada@localhost\nhost=localhost\n", LOCAL),
    ).toBe("mail=user@localhost\nhost=localhost\n");
  });
});

describe("identityLeftIn", () => {
  it("finds the host name and user@host anywhere, the home as a whole path, and not the user name alone", () => {
    const texts = [
      '["mail=ada@e81232be457d"]',
      "e81232be457d-notes.txt",
      "http://e81232be457d.local/",
      "x/home/ada/y",
      "/home/adam/x",
      '["author=ada"]',
    ];

    expect(texts.map((text) => identityLeftIn(text, GEANY))).toEqual([
      "ada@e81232be457d",
      "e81232be457d",
      "e81232be457d",
      "/home/ada",
      undefined,
      undefined,
    ]);
  });

  it("does not take the replacements for what they replaced", () => {
    const host = { home: "/home", hostname: "host", user: "user" };

    expect(
      identityLeftIn(`mail=user@localhost on localhost in ${SEED_HOME}`, host),
    ).toBeUndefined();
    expect(identityLeftIn("ghost /home/ada", host)).toBe("/home");
    expect(identityLeftIn("mail=ada@localhost", LOCAL)).toBe("ada@localhost");
    expect(identityLeftIn("mail=user@localhost", LOCAL)).toBeUndefined();
  });
});
