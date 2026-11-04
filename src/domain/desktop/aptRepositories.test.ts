import { describe, expect, it } from "vitest";

import {
  aptListFileName,
  aptReleaseFilePrefix,
  dearmorPublicKeys,
  isArmoredKey,
  parseDeb822Sources,
  parseOneLineSources,
  sourceEntryFor,
  validSignatureFingerprint,
} from "./aptRepositories.js";

/** `/etc/apt/sources.list.d/ubuntu.sources` from Ubuntu 24.04 arm64, its comment block shortened. */
const UBUNTU_SOURCES = [
  "# See http://help.ubuntu.com/community/UpgradeNotes for how to upgrade to",
  "## See the sources.list(5) manual page for further settings.",
  "Types: deb",
  "URIs: http://ports.ubuntu.com/ubuntu-ports/",
  "Suites: noble noble-updates noble-backports",
  "Components: main universe restricted multiverse",
  "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg",
  "",
  "## Ubuntu security updates. Aside from URIs and Suites,",
  "Types: deb",
  "URIs: http://ports.ubuntu.com/ubuntu-ports/",
  "Suites: noble-security",
  "Components: main universe restricted multiverse",
  "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg",
  "",
].join("\n");

/** gpgv 2.4.4 status for Typora's InRelease checked with its key. */
const GPGV_GOOD = [
  "[GNUPG:] NEWSIG abner@typora.io",
  "[GNUPG:] KEY_CONSIDERED 4AC441BE68B4ADAB7439FBF9BA300B7755AFCFAE 0",
  "[GNUPG:] SIG_ID LC8Zjocgh29eX3XgE2kMwdMeLfI 2026-08-05 1785919691",
  "[GNUPG:] GOODSIG BA300B7755AFCFAE Abner Lee (keys for Typora linux packages) <abner@typora.io>",
  "[GNUPG:] VALIDSIG 4AC441BE68B4ADAB7439FBF9BA300B7755AFCFAE 2026-08-05 1785919691 0 4 0 1 10 01 4AC441BE68B4ADAB7439FBF9BA300B7755AFCFAE",
  "",
].join("\n");

describe("parseOneLineSources", () => {
  it("reads a flat repository as Typora's instructions write it", () => {
    expect(
      parseOneLineSources(
        "deb https://downloads.typora.io/linux ./\n",
        "/etc/apt/sources.list.d/typora.list",
      ),
    ).toEqual([
      {
        file: "/etc/apt/sources.list.d/typora.list",
        uri: "https://downloads.typora.io/linux",
        suite: "./",
        components: [],
        architectures: [],
        signedBy: [],
        inlineKey: false,
      },
    ]);
  });

  it("reads options, components and comments, and skips deb-src lines", () => {
    expect(
      parseOneLineSources(
        [
          "# Vendor repository",
          "deb [arch=amd64,arm64 signed-by=/usr/share/keyrings/vendor.gpg] https://apt.example.com/repo/ noble main contrib # pinned",
          "deb-src https://apt.example.com/repo noble main",
        ].join("\n"),
        "/etc/apt/sources.list.d/vendor.list",
      ),
    ).toEqual([
      expect.objectContaining({
        uri: "https://apt.example.com/repo",
        suite: "noble",
        components: ["main", "contrib"],
        architectures: ["amd64", "arm64"],
        signedBy: ["/usr/share/keyrings/vendor.gpg"],
      }),
    ]);
  });
});

describe("parseDeb822Sources", () => {
  it("expands each URI and suite of Ubuntu's own sources file", () => {
    const entries = parseDeb822Sources(UBUNTU_SOURCES, "ubuntu.sources");

    expect(entries.map((entry) => entry.suite)).toEqual([
      "noble",
      "noble-updates",
      "noble-backports",
      "noble-security",
    ]);
    expect(entries[0]).toMatchObject({
      uri: "http://ports.ubuntu.com/ubuntu-ports",
      components: ["main", "universe", "restricted", "multiverse"],
      signedBy: ["/usr/share/keyrings/ubuntu-archive-keyring.gpg"],
    });
  });

  it("skips disabled paragraphs and marks a Signed-By that holds the key itself", () => {
    const entries = parseDeb822Sources(
      [
        "Types: deb",
        "URIs: https://ppa.launchpadcontent.net/a/b/ubuntu/",
        "Suites: noble",
        "Components: main",
        "Architectures: arm64",
        "Signed-By:",
        " -----BEGIN PGP PUBLIC KEY BLOCK-----",
        " .",
        " mQINBGdummy",
        " -----END PGP PUBLIC KEY BLOCK-----",
        "",
        "Types: deb",
        "URIs: https://example.com/off",
        "Suites: ./",
        "Enabled: no",
      ].join("\n"),
      "a-ubuntu-b-noble.sources",
    );

    expect(entries).toEqual([
      expect.objectContaining({
        uri: "https://ppa.launchpadcontent.net/a/b/ubuntu",
        architectures: ["arm64"],
        signedBy: [],
        inlineKey: true,
      }),
    ]);
  });
});

describe("sourceEntryFor", () => {
  const entries = [
    ...parseDeb822Sources(UBUNTU_SOURCES, "ubuntu.sources"),
    ...parseOneLineSources(
      "deb https://downloads.typora.io/linux ./",
      "typora.list",
    ),
  ];

  it("matches apt-cache policy's flat and per-component source text", () => {
    expect(
      sourceEntryFor("https://downloads.typora.io/linux ./ Packages", entries),
    ).toMatchObject({ file: "typora.list", suite: "./" });
    expect(
      sourceEntryFor(
        "http://ports.ubuntu.com/ubuntu-ports noble-security/universe arm64 Packages",
        entries,
      ),
    ).toMatchObject({ suite: "noble-security" });
    expect(
      sourceEntryFor("https://downloads.typora.io/other ./ Packages", entries),
    ).toBeUndefined();
  });
});

describe("apt list file names", () => {
  it("names release files as apt stores them in its lists directory", () => {
    const [typora] = parseOneLineSources(
      "deb https://downloads.typora.io/linux ./",
      "typora.list",
    );
    const [noble] = parseDeb822Sources(UBUNTU_SOURCES, "ubuntu.sources");
    if (typora === undefined || noble === undefined)
      throw new Error("no entry");

    expect(`${aptReleaseFilePrefix(typora)}InRelease`).toBe(
      "downloads.typora.io_linux_._InRelease",
    );
    expect(`${aptReleaseFilePrefix(noble)}InRelease`).toBe(
      "ports.ubuntu.com_ubuntu-ports_dists_noble_InRelease",
    );
  });

  it("drops credentials and quotes the characters apt quotes", () => {
    const uri = new URL("https://apt.example.com/a_b~c/");
    uri.username = "user";
    uri.password = "pw";
    expect(aptListFileName(uri.href)).toBe("apt.example.com_a%5fb%7ec_");
  });
});

describe("gpgv and key files", () => {
  it("reads the primary key fingerprint of a valid signature only", () => {
    expect(validSignatureFingerprint(GPGV_GOOD)).toBe(
      "4AC441BE68B4ADAB7439FBF9BA300B7755AFCFAE",
    );
    expect(
      validSignatureFingerprint(
        [
          "[GNUPG:] NEWSIG abner@typora.io",
          "[GNUPG:] ERRSIG BA300B7755AFCFAE 1 10 01 1785919691 9 4AC441BE68B4ADAB7439FBF9BA300B7755AFCFAE",
          "[GNUPG:] NO_PUBKEY BA300B7755AFCFAE",
        ].join("\n"),
      ),
    ).toBeUndefined();
  });

  it("decodes every armored key block to binary and tells armor from binary by content", () => {
    const first = Buffer.from(Array.from({ length: 70 }, (_, index) => index));
    const second = Buffer.from([0x99, 0x01, 0x0d]);
    const armor = (bytes: Buffer, header: string) =>
      [
        "-----BEGIN PGP PUBLIC KEY BLOCK-----",
        header,
        "",
        ...(bytes.toString("base64").match(/.{1,64}/gu) ?? []),
        "=ABCD",
        "-----END PGP PUBLIC KEY BLOCK-----",
      ].join("\r\n");
    const text = Buffer.from(
      `\n${armor(first, "Comment: vendor key")}\n${armor(second, "Version: GnuPG v2")}\n`,
    );

    expect(isArmoredKey(text)).toBe(true);
    expect(isArmoredKey(first)).toBe(false);
    expect(dearmorPublicKeys(text)?.toString("hex")).toBe(
      Buffer.concat([first, second]).toString("hex"),
    );
    expect(dearmorPublicKeys(Buffer.from("not a key"))).toBeUndefined();
  });
});
