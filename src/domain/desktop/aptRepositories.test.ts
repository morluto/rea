import { describe, expect, it } from "vitest";

import { GPGV_A_ONLY, VENDOR_A } from "./aptKeys.fixture.js";
import {
  aptListFileName,
  dearmorPublicKeys,
  entryForTarget,
  isArmoredKey,
  isUbuntuProRepository,
  parseAptIndexTargets,
  parseDeb822Sources,
  parseOneLineSources,
  validSignature,
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

const TYPORA_LIST = "/etc/apt/sources.list.d/typora.list";
const K8S_LIST = "/etc/apt/sources.list.d/kubernetes.list";

/** `apt-get indextargets "Created-By: Packages"` on Ubuntu 24.04 with Typora's flat `./` repository and pkgs.k8s.io's flat `/` one. */
const INDEX_TARGETS = [
  "MetaKey: Packages",
  "ShortDesc: Packages",
  "Description: https://downloads.typora.io/linux ./ Packages",
  "URI: https://downloads.typora.io/linux/./Packages",
  "Filename: /var/lib/apt/lists/downloads.typora.io_linux_._Packages.lz4",
  "Optional: no",
  "KeepCompressed: yes",
  "Codename: stable",
  "Label: Typora",
  "Origin: typora.io",
  "Suite: stable",
  "Trusted: yes",
  "Base-URI: https://downloads.typora.io/linux/./",
  "Release: ./",
  "Repo-URI: https://downloads.typora.io/linux/",
  "Site: https://downloads.typora.io/linux",
  `Sourcesentry: ${TYPORA_LIST}:1`,
  "Target-Of: deb",
  "",
  "MetaKey: Packages",
  "Description: https://pkgs.k8s.io/core:/stable:/v1.30/deb  Packages",
  "URI: https://pkgs.k8s.io/core:/stable:/v1.30/deb/Packages",
  "Filename: /var/lib/apt/lists/pkgs.k8s.io_core:_stable:_v1.30_deb_Packages.lz4",
  "Codename: deb",
  "Label: isv:kubernetes:core:stable:v1.30",
  "Origin: obs://build.opensuse.org/isv:kubernetes:core:stable:v1.30/deb",
  "Trusted: yes",
  "Base-URI: https://pkgs.k8s.io/core:/stable:/v1.30/deb/",
  "Fallback-Of: ",
  "Release: ",
  "Repo-URI: https://pkgs.k8s.io/core:/stable:/v1.30/deb/",
  `Sourcesentry: ${K8S_LIST}:1`,
  "Target-Of: deb",
  "",
  "MetaKey: main/binary-arm64/Packages",
  "Description: http://ports.ubuntu.com/ubuntu-ports noble-updates/main arm64 Packages",
  "Filename: /var/lib/apt/lists/ports.ubuntu.com_ubuntu-ports_dists_noble-updates_main_binary-arm64_Packages.lz4",
  "Codename: noble",
  "Label: Ubuntu",
  "Origin: Ubuntu",
  "Suite: noble-updates",
  "Version: 24.04",
  "Architecture: arm64",
  "Base-URI: http://ports.ubuntu.com/ubuntu-ports/dists/noble-updates/",
  "Component: main",
  "Release: noble-updates",
  "Repo-URI: http://ports.ubuntu.com/ubuntu-ports/",
  "Sourcesentry: /etc/apt/sources.list.d/ubuntu.sources:1",
  "Target-Of: deb",
  "",
].join("\n");

describe("parseOneLineSources", () => {
  it("reads a flat repository as Typora's instructions write it", () => {
    expect(
      parseOneLineSources(
        "deb https://downloads.typora.io/linux ./\n",
        TYPORA_LIST,
      ),
    ).toEqual([
      {
        file: TYPORA_LIST,
        position: 1,
        uri: "https://downloads.typora.io/linux",
        suite: "./",
        components: [],
        architectures: [],
        signedBy: [],
        inlineKey: false,
      },
    ]);
  });

  it("reads options, components and comments, skips deb-src lines and numbers entries by line", () => {
    expect(
      parseOneLineSources(
        [
          "# Vendor repository",
          "deb-src https://apt.example.com/repo noble main",
          "deb [arch=amd64,arm64 signed-by=/usr/share/keyrings/vendor.gpg] https://apt.example.com/repo/ noble main contrib # pinned",
        ].join("\n"),
        "/etc/apt/sources.list.d/vendor.list",
      ),
    ).toEqual([
      expect.objectContaining({
        position: 3,
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
  it("expands each URI and suite of Ubuntu's own sources file and numbers its stanzas", () => {
    const entries = parseDeb822Sources(UBUNTU_SOURCES, "ubuntu.sources");

    expect(entries.map(({ suite, position }) => [suite, position])).toEqual([
      ["noble", 1],
      ["noble-updates", 1],
      ["noble-backports", 1],
      ["noble-security", 2],
    ]);
    expect(entries[0]).toMatchObject({
      uri: "http://ports.ubuntu.com/ubuntu-ports",
      components: ["main", "universe", "restricted", "multiverse"],
      signedBy: ["/usr/share/keyrings/ubuntu-archive-keyring.gpg"],
    });
  });

  it("skips disabled stanzas yet counts them, as apt does, and marks a Signed-By that holds the key itself", () => {
    const entries = parseDeb822Sources(
      [
        "# a comment-only paragraph apt does not count",
        "",
        "Types: deb",
        "URIs: https://example.com/off",
        "Suites: /",
        "Enabled: no",
        "",
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
      ].join("\n"),
      "a-ubuntu-b-noble.sources",
    );

    expect(entries).toEqual([
      expect.objectContaining({
        position: 2,
        uri: "https://ppa.launchpadcontent.net/a/b/ubuntu",
        architectures: ["arm64"],
        signedBy: [],
        inlineKey: true,
      }),
    ]);
  });
});

describe("apt index targets", () => {
  const targets = parseAptIndexTargets(INDEX_TARGETS);

  it("reads each index's policy text, sources entry and release, flat suites included", () => {
    expect(targets).toEqual([
      {
        description: "https://downloads.typora.io/linux ./ Packages",
        sourcesFile: TYPORA_LIST,
        position: 1,
        repoUri: "https://downloads.typora.io/linux/",
        release: "./",
        baseUri: "https://downloads.typora.io/linux/./",
        filename: "/var/lib/apt/lists/downloads.typora.io_linux_._Packages.lz4",
        origin: "typora.io",
        suite: "stable",
        codename: "stable",
      },
      expect.objectContaining({
        description: "https://pkgs.k8s.io/core:/stable:/v1.30/deb  Packages",
        sourcesFile: K8S_LIST,
        release: "",
        suite: null,
        codename: "deb",
      }),
      expect.objectContaining({
        sourcesFile: "/etc/apt/sources.list.d/ubuntu.sources",
        release: "noble-updates",
        origin: "Ubuntu",
      }),
    ]);
  });

  it("names release files as apt stores them in its lists directory", () => {
    expect(
      targets.map((target) => `${aptListFileName(target.baseUri)}InRelease`),
    ).toEqual([
      "downloads.typora.io_linux_._InRelease",
      "pkgs.k8s.io_core:_stable:_v1.30_deb_InRelease",
      "ports.ubuntu.com_ubuntu-ports_dists_noble-updates_InRelease",
    ]);
    const uri = new URL("https://apt.example.com/a_b~c/");
    uri.username = "user";
    uri.password = "pw";
    expect(aptListFileName(uri.href)).toBe("apt.example.com_a%5fb%7ec_");
  });

  it("finds the sources entry of each target, by position and then URI and suite", () => {
    const [typora, k8s, noble] = targets;
    if (typora === undefined || k8s === undefined || noble === undefined)
      throw new Error("missing target");
    const entries = [
      ...parseOneLineSources(
        "deb https://downloads.typora.io/linux ./",
        TYPORA_LIST,
      ),
      ...parseOneLineSources(
        "deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.30/deb/ /",
        K8S_LIST,
      ),
      ...parseDeb822Sources(
        UBUNTU_SOURCES,
        "/etc/apt/sources.list.d/ubuntu.sources",
      ),
    ];

    expect(entryForTarget(typora, entries)).toMatchObject({ suite: "./" });
    expect(entryForTarget(k8s, entries)).toMatchObject({
      uri: "https://pkgs.k8s.io/core:/stable:/v1.30/deb",
      suite: "/",
      signedBy: ["/etc/apt/keyrings/kubernetes-apt-keyring.gpg"],
    });
    expect(entryForTarget(noble, entries)).toMatchObject({
      suite: "noble-updates",
      position: 1,
    });
    expect(entryForTarget({ ...typora, position: 2 }, entries)).toBeUndefined();
  });
});

describe("validSignature", () => {
  it("takes a valid signature even when another key's missing signature makes gpgv fail", () => {
    expect(validSignature(GPGV_A_ONLY)).toEqual({
      signing: VENDOR_A.fingerprint,
      primary: VENDOR_A.fingerprint,
    });
  });

  it("refuses a key that a bad, expired or revoked signature names, and an unverified signature", () => {
    const [newsig, considered, sigId, , validsig] = GPGV_A_ONLY.split("\n");
    for (const line of [
      "[GNUPG:] BADSIG 6701CFD5B893036C Vendor A <a@example.com>",
      "[GNUPG:] EXPKEYSIG 6701CFD5B893036C Vendor A <a@example.com>",
      "[GNUPG:] REVKEYSIG 6701CFD5B893036C Vendor A <a@example.com>",
    ])
      expect(
        validSignature([newsig, considered, sigId, line, validsig].join("\n")),
      ).toBeUndefined();
    expect(
      validSignature(GPGV_A_ONLY.split("\n").slice(5).join("\n")),
    ).toBeUndefined();
  });
});

describe("repository kinds and key files", () => {
  it("recognises Ubuntu Pro's ESM repositories by origin or host", () => {
    expect(isUbuntuProRepository("UbuntuESMApps", null)).toBe(true);
    expect(isUbuntuProRepository("UbuntuESM", null)).toBe(true);
    expect(
      isUbuntuProRepository(null, "https://esm.ubuntu.com/apps/ubuntu"),
    ).toBe(true);
    expect(
      isUbuntuProRepository("typora.io", "https://downloads.typora.io/linux"),
    ).toBe(false);
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
