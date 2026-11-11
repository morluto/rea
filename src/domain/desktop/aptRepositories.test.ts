import { describe, expect, it } from "vitest";

import {
  A_ARMORED,
  GPGV_A_ONLY,
  inlineSignedBy,
  VENDOR_A,
} from "./aptKeys.fixture.js";
import {
  aptListFileName,
  dearmorPublicKeys,
  declaredPackageFiles,
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
        uris: ["https://downloads.typora.io/linux"],
        credentialed: [],
        suites: ["./"],
        components: [],
        architectures: [],
        signedBy: [],
        inlineKey: null,
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
        uris: ["https://apt.example.com/repo"],
        suites: ["noble"],
        components: ["main", "contrib"],
        architectures: ["amd64", "arm64"],
        signedBy: ["/usr/share/keyrings/vendor.gpg"],
      }),
    ]);
  });
});

describe("parseDeb822Sources", () => {
  it("reads each URI and suite of Ubuntu's own sources file and numbers its stanzas", () => {
    const stanzas = parseDeb822Sources(UBUNTU_SOURCES, "ubuntu.sources");

    expect(stanzas.map(({ suites, position }) => [suites, position])).toEqual([
      [["noble", "noble-updates", "noble-backports"], 1],
      [["noble-security"], 2],
    ]);
    expect(stanzas[0]).toMatchObject({
      uris: ["http://ports.ubuntu.com/ubuntu-ports"],
      components: ["main", "universe", "restricted", "multiverse"],
      signedBy: ["/usr/share/keyrings/ubuntu-archive-keyring.gpg"],
    });
  });

  it("skips disabled stanzas yet counts them, as apt does, and reads a Signed-By that holds the key itself", () => {
    const stanzas = parseDeb822Sources(
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

    expect(stanzas).toEqual([
      expect.objectContaining({
        position: 2,
        uris: ["https://ppa.launchpadcontent.net/a/b/ubuntu"],
        architectures: ["arm64"],
        signedBy: [],
        inlineKey:
          "-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nmQINBGdummy\n-----END PGP PUBLIC KEY BLOCK-----\n",
      }),
    ]);
  });

  it("reads the key a PPA's Signed-By holds as add-apt-repository writes it, so it dearmors to the key", () => {
    const [stanza] = parseDeb822Sources(
      [
        "Types: deb",
        "URIs: https://ppa.launchpadcontent.net/freecad-maintainers/freecad-stable/ubuntu/",
        "Suites: noble",
        "Components: main",
        inlineSignedBy(A_ARMORED),
        "",
      ].join("\n"),
      "/etc/apt/sources.list.d/freecad-maintainers-ubuntu-freecad-stable-noble.sources",
    );

    expect(stanza).toMatchObject({ signedBy: [], inlineKey: A_ARMORED });
    expect(
      dearmorPublicKeys(Buffer.from(stanza?.inlineKey ?? ""))?.equals(
        VENDOR_A.key,
      ),
    ).toBe(true);
  });

  it("reads a key that starts on the Signed-By line, with tab-indented lines and a field after it", () => {
    const [stanza] = parseDeb822Sources(
      [
        "Types: deb",
        "URIs: https://ppa.launchpadcontent.net/a/b/ubuntu/",
        "Suites: noble",
        `Signed-By: ${A_ARMORED.trimEnd().replaceAll("\n\n", "\n.\n").replaceAll("\n", "\n\t ")}`,
        "# a comment between fields",
        "Components: main",
      ].join("\n"),
      "a-ubuntu-b-noble.sources",
    );

    expect(stanza).toMatchObject({
      components: ["main"],
      inlineKey: A_ARMORED,
    });
  });

  it("keeps a stanza's URIs and suites as lists and resolves a target's pair from them, without expanding every pair", () => {
    const uris = Array.from(
      { length: 500 },
      (_, index) => `https://mirror${String(index)}.example.com/apt/`,
    );
    const suites = Array.from(
      { length: 500 },
      (_, index) => `suite${String(index)}`,
    );
    const file = "/etc/apt/sources.list.d/mirrors.sources";
    const stanzas = parseDeb822Sources(
      `Types: deb\nURIs: ${uris.join(" ")}\nSuites: ${suites.join(" ")}\nComponents: main\n`,
      file,
    );
    const [target] = parseAptIndexTargets(INDEX_TARGETS);
    if (target === undefined) throw new Error("missing target");

    expect(stanzas).toHaveLength(1);
    expect(
      entryForTarget(
        {
          ...target,
          sourcesFile: file,
          repoUri: "https://mirror499.example.com/apt/",
          release: "suite499",
        },
        stanzas,
      ),
    ).toMatchObject({
      uri: "https://mirror499.example.com/apt",
      suite: "suite499",
      components: ["main"],
    });
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
        component: null,
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
        component: "main",
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
    const stanzas = [
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

    expect(entryForTarget(typora, stanzas)).toMatchObject({ suite: "./" });
    expect(entryForTarget(k8s, stanzas)).toMatchObject({
      uri: "https://pkgs.k8s.io/core:/stable:/v1.30/deb",
      suite: "/",
      signedBy: ["/etc/apt/keyrings/kubernetes-apt-keyring.gpg"],
    });
    expect(entryForTarget(noble, stanzas)).toMatchObject({
      suite: "noble-updates",
      position: 1,
    });
    expect(entryForTarget({ ...typora, position: 2 }, stanzas)).toBeUndefined();
  });
});

describe("credentials in a source URI", () => {
  const ONE_LINE_FILE = "/etc/apt/sources.list.d/private.list";
  const DEB822_FILE = "/etc/apt/sources.list.d/private.sources";
  const CREDENTIALS = /rea-user|hunter2/u;

  it("removes a user name and password from one-line entries and marks the URIs that held them", () => {
    const stanzas = parseOneLineSources(
      [
        "deb https://rea-user:hunter2@apt.example.com/repo/ stable main",
        "deb [arch=amd64] https://rea-user@apt.example.com/user-only noble main",
        "deb https://rea-user:hunter2@ss@apt.example.com/at-sign stable main",
        "deb https://apt.example.com/open stable main",
      ].join("\n"),
      ONE_LINE_FILE,
    );

    expect(
      stanzas.map(({ uris, credentialed }) => ({ uris, credentialed })),
    ).toEqual([
      {
        uris: ["https://apt.example.com/repo"],
        credentialed: ["https://apt.example.com/repo"],
      },
      {
        uris: ["https://apt.example.com/user-only"],
        credentialed: ["https://apt.example.com/user-only"],
      },
      {
        uris: ["https://apt.example.com/at-sign"],
        credentialed: ["https://apt.example.com/at-sign"],
      },
      { uris: ["https://apt.example.com/open"], credentialed: [] },
    ]);
    expect(JSON.stringify(stanzas)).not.toMatch(CREDENTIALS);
  });

  it("removes them from each URI of a deb822 stanza, marking only the URIs that held them", () => {
    const stanzas = parseDeb822Sources(
      [
        "Types: deb",
        "URIs: https://rea-user:hunter2@apt.example.com/repo/ https://rea-user@mirror.example.com/repo https://open.example.com/repo",
        "Suites: stable",
        "Components: main",
      ].join("\n"),
      DEB822_FILE,
    );

    expect(stanzas).toEqual([
      expect.objectContaining({
        uris: [
          "https://apt.example.com/repo",
          "https://mirror.example.com/repo",
          "https://open.example.com/repo",
        ],
        credentialed: [
          "https://apt.example.com/repo",
          "https://mirror.example.com/repo",
        ],
      }),
    ]);
    expect(JSON.stringify(stanzas)).not.toMatch(CREDENTIALS);
  });

  it("matches index targets to entries whether or not apt-get indextargets prints the credentials", () => {
    const stanzas = parseDeb822Sources(
      [
        "Types: deb",
        "URIs: https://rea-user:hunter2@apt.example.com/repo/ https://open.example.com/repo",
        "Suites: stable",
        "Components: main",
      ].join("\n"),
      DEB822_FILE,
    );
    const description =
      "https://apt.example.com/repo stable/main amd64 Packages";
    for (const repoUri of [
      "https://rea-user:hunter2@apt.example.com/repo/",
      "https://apt.example.com/repo/",
    ]) {
      const [target] = parseAptIndexTargets(
        [
          `Description: ${repoUri.slice(0, -1)} stable/main amd64 Packages`,
          "Filename: /var/lib/apt/lists/apt.example.com_repo_dists_stable_main_binary-amd64_Packages",
          `Base-URI: ${repoUri}dists/stable/`,
          "Component: main",
          "Release: stable",
          `Repo-URI: ${repoUri}`,
          `Sourcesentry: ${DEB822_FILE}:1`,
        ].join("\n"),
      );
      if (target === undefined) throw new Error("missing target");

      expect(target).toMatchObject({
        description,
        repoUri: "https://apt.example.com/repo/",
        baseUri: "https://apt.example.com/repo/dists/stable/",
      });
      const entry = entryForTarget(target, stanzas);
      expect(entry).toMatchObject({
        uri: "https://apt.example.com/repo",
        credentials: true,
      });
      expect(JSON.stringify([target, entry])).not.toMatch(CREDENTIALS);
      expect([
        ...declaredPackageFiles(
          [
            {
              uri: "https://apt.example.com/repo",
              suite: "stable",
              components: ["main"],
            },
          ],
          [target],
        ),
      ]).toEqual([description]);
    }
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
