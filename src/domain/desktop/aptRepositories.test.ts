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
  deb822Paragraphs,
  declaredPackageFiles,
  entryForTarget,
  isArmoredKey,
  isUbuntuProRepository,
  parseAptIndexTargets,
  parseAptConfigShell,
  parseDeb822Sources,
  parseOneLineSources,
  validSignature,
} from "./aptRepositories.js";

describe("apt-config shell assignments", () => {
  it.each([
    "",
    "/var/lib/apt/lists/",
    "/tmp/user's lists/",
    "/tmp/lists\ncustom/",
    "/tmp/'\nPARTS=literal\n\\tail/",
  ])("preserves a complete quoted value %j", (value) => {
    const assignment = `LISTS='${value.replaceAll("'", "'\\''")}'\n`;
    expect(parseAptConfigShell(assignment)).toEqual(
      new Map([["LISTS", value]]),
    );
  });

  it("keeps multiline values separate from adjacent assignments", () => {
    const values = new Map([
      ["LISTS", "/tmp/lists\ncustom/"],
      ["PARTS", "/tmp/key's\nparts/"],
      ["TRUSTED", "/tmp/trusted\\keys.gpg"],
    ]);
    const output = [...values]
      .map(([name, value]) => `${name}='${value.replaceAll("'", "'\\''")}'\n`)
      .join("");
    expect(parseAptConfigShell(output)).toEqual(values);
    expect(parseAptConfigShell(output.slice(0, -1))).toEqual(values);
  });

  it("does not promote an assignment-looking line from an incomplete quoted value", () => {
    expect(parseAptConfigShell("LISTS='unclosed\nPARTS='decoy'\n")).toEqual(
      new Map(),
    );
  });
});

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
        format: "one-line",
        uris: [
          { uri: "https://downloads.typora.io/linux", credentials: false },
        ],
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
        uris: [{ uri: "https://apt.example.com/repo/", credentials: false }],
        suites: ["noble"],
        components: ["main", "contrib"],
        architectures: ["amd64", "arm64"],
        signedBy: ["/usr/share/keyrings/vendor.gpg"],
      }),
    ]);
  });
  it("preserves non-ASCII whitespace inside and at the edges of APT list words", () => {
    const uri = "https://vendor.invalid/edge\u00a0embedded\u00a0";
    const suite = "\u00a0stable";
    const component = "main\u00a0";
    expect(
      parseOneLineSources(`deb\t${uri} ${suite} ${component}\n`, TYPORA_LIST),
    ).toMatchObject([
      {
        uris: [{ uri, credentials: false }],
        suites: [suite],
        components: [component],
      },
    ]);
  });

  it("keeps a hash inside an option and strips the trailing comment", () => {
    expect(
      parseOneLineSources(
        "deb [signed-by=/usr/share/keyrings/vendor#1.gpg] https://vendor.invalid/archive stable main # extra",
        TYPORA_LIST,
      ),
    ).toMatchObject([
      {
        uris: [{ uri: "https://vendor.invalid/archive", credentials: false }],
        suites: ["stable"],
        components: ["main"],
        signedBy: ["/usr/share/keyrings/vendor#1.gpg"],
      },
    ]);
  });

  it("decodes quoted or escaped option assignments and keeps option names case-sensitive", () => {
    expect(
      parseOneLineSources(
        'deb [arch%3D"amd64" Arch=arm64 signed-by="/usr/share/keyrings/vendor[1]%2Egpg"] https://vendor.invalid/archive stable main',
        TYPORA_LIST,
      ),
    ).toMatchObject([
      {
        architectures: ["amd64"],
        signedBy: ["/usr/share/keyrings/vendor[1].gpg"],
      },
    ]);
  });

  it.each(['arch="amd64', "arch", "arch="])(
    "does not attribute a repository to a malformed option (%s)",
    (option) => {
      expect(
        parseOneLineSources(
          `deb [${option}] https://vendor.invalid/archive stable main`,
          TYPORA_LIST,
        ),
      ).toEqual([]);
    },
  );
});

describe("parseDeb822Sources", () => {
  it("reads each URI and suite of Ubuntu's own sources file and numbers its stanzas", () => {
    const stanzas = parseDeb822Sources(UBUNTU_SOURCES, "ubuntu.sources");

    expect(stanzas.map(({ suites, position }) => [suites, position])).toEqual([
      [["noble", "noble-updates", "noble-backports"], 1],
      [["noble-security"], 2],
    ]);
    expect(stanzas[0]).toMatchObject({
      uris: [
        { uri: "http://ports.ubuntu.com/ubuntu-ports/", credentials: false },
      ],
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
        uris: [
          {
            uri: "https://ppa.launchpadcontent.net/a/b/ubuntu/",
            credentials: false,
          },
        ],
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

  it.each([
    ["file:/srv/apt/dists/stable/", "_srv_apt_dists_stable_InRelease"],
    [
      "copy:/tmp/snapshot/dists/stable/",
      "_tmp_snapshot_dists_stable_InRelease",
    ],
    [
      "file://machine/srv/apt/dists/stable/",
      "machine_srv_apt_dists_stable_InRelease",
    ],
    ["https://[2001:db8::1]:8443/apt/", "2001:db8::1:8443_apt_InRelease"],
    ["https://[2001:db8::1]/apt/", "2001:db8::1_apt_InRelease"],
    [
      "https://[fe80::1%eth0]/apt/dists/stable/",
      "fe80::1%25eth0_apt_dists_stable_InRelease",
    ],
    ["https://example.invalid/apt[1]/", "example.invalid_apt%5b1%5d_InRelease"],
  ])("uses apt's release filename spelling for %s", (uri, filename) => {
    expect(`${aptListFileName(uri)}InRelease`).toBe(filename);
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

const deb822LookupFile = "/etc/apt/sources.list.d/vendor.sources";

const targetFor = (
  repoUri: string,
  description = repoUri,
  component = "main",
) => ({
  description,
  sourcesFile: deb822LookupFile,
  position: 1,
  repoUri,
  release: "stable",
  component,
  baseUri: `${repoUri}dists/stable/`,
  filename: "/var/lib/apt/lists/vendor",
  origin: null,
  suite: null,
  codename: null,
});

describe("single-stanza APT source identity", () => {
  it("requires a single deb822 declaration to match the observed URI and suite", () => {
    const stanzas = parseDeb822Sources(
      "Types: deb\nURIs: https://vendor.invalid/archive\nSuites: stable\nComponents: main\n",
      deb822LookupFile,
    );
    expect(
      entryForTarget(targetFor("https://vendor.invalid/archive/"), stanzas),
    ).toMatchObject({ suite: "stable" });
    expect(
      entryForTarget(targetFor("https://other.invalid/archive/"), stanzas),
    ).toBeUndefined();
    expect(
      entryForTarget(
        { ...targetFor("https://vendor.invalid/archive/"), release: "testing" },
        stanzas,
      ),
    ).toBeUndefined();
  });

  it.each([
    ["https://vendor.invalid:/archive", "https://vendor.invalid/archive/"],
    ["https://[2001:db8::11]:/apt", "https://[2001:db8::11]/apt/"],
    [
      "https://vendor.invalid:80abc/archive",
      "https://vendor.invalid:80/archive/",
    ],
    ["https://vendor.invalid:https/archive", "https://vendor.invalid/archive/"],
    [
      "https://vendor.invalid:0080abc/archive",
      "https://vendor.invalid:80/archive/",
    ],
    [
      "https://vendor.invalid:+80abc/archive",
      "https://vendor.invalid:80/archive/",
    ],
    [
      "https://vendor.invalid:-80/archive",
      "https://vendor.invalid:4294967216/archive/",
    ],
    [
      "https://vendor.invalid:4294967296/archive",
      "https://vendor.invalid/archive/",
    ],
    [
      "https://vendor.invalid:2147483648abc/archive",
      "https://vendor.invalid:2147483648/archive/",
    ],
    [
      "https://vendor.invalid:999999999999999999999/archive",
      "https://vendor.invalid:4294967295/archive/",
    ],
    ["https://[2001:db8::11]:80abc/apt", "https://[2001:db8::11]:80/apt/"],
    ["https://[2001:db8::11]:https/apt", "https://[2001:db8::11]/apt/"],
    ["https://[::1]:80:abc/apt", "https://[::1:80]/apt/"],
    [
      "https://vendor.invalid:foo:80abc/archive",
      "https://[vendor.invalid:foo]:80/archive/",
    ],
    [
      "https://vendor.invalid/archive:80abc/x",
      "https://vendor.invalid/archive:80abc/x/",
    ],
    ["file://hostname:80abc/path", "file://hostname:80/path/"],
    ["file://", "file://"],
    ["file:///", "file:/"],
    ["file:///srv/a%20b", "file:/srv/a%20b/"],
  ])(
    "matches %s to the Repo-URI APT emits and keeps the authored URI",
    (authored, repoUri) => {
      const stanzas = parseDeb822Sources(
        `Types: deb\nURIs: ${authored}\nSuites: stable\nComponents: main\n`,
        deb822LookupFile,
      );
      expect(entryForTarget(targetFor(repoUri), stanzas)).toEqual({
        file: deb822LookupFile,
        position: 1,
        uri: authored,
        credentials: false,
        suite: "stable",
        components: ["main"],
        architectures: [],
        signedBy: [],
        inlineKey: null,
      });
      const untouched = authored.endsWith("/") ? authored : `${authored}/`;
      if (untouched !== repoUri)
        expect(entryForTarget(targetFor(untouched), stanzas)).toBeUndefined();
    },
  );

  it.each([
    {
      field: "suite",
      uri: "https://vendor.invalid/archive",
      suite: "unstable/binary-$(ARCH)/",
    },
    {
      field: "URI",
      uri: "https://vendor.invalid/archive-$(ARCH)",
      suite: "unstable/binary-amd64/",
    },
  ])(
    "uses APT's configured architecture in a deb822 $field for identity and attribution",
    ({ field, uri, suite }) => {
      const observedUri = uri.replace("$(ARCH)", "amd64");
      const stanzas = parseDeb822Sources(
        `Types: deb\nURIs: ${uri}\nSuites: ${suite}\n`,
        deb822LookupFile,
      );
      const description = `${observedUri} unstable/binary-amd64/ Packages`;
      // Offline APT emits the expanded Release and no per-target Architecture
      // on this flat index. The source file and index still retain different facts.
      const transcript = [
        `Description: ${description}`,
        "Filename: /var/lib/apt/lists/apt-owned-Packages",
        `Base-URI: ${observedUri}/unstable/binary-amd64/`,
        `Repo-URI: ${observedUri}/`,
        "Release: unstable/binary-amd64/",
        `Sourcesentry: ${deb822LookupFile}:1`,
      ].join("\n");
      const repository = {
        source: description,
        uri,
        repo_uri: `${observedUri}/`,
        sources_file: deb822LookupFile,
        uri_credentials_removed: false,
        suite,
        ...(field === "suite" ? { repo_suite: "unstable/binary-amd64/" } : {}),
        components: [],
      };
      for (const architecture of ["amd64", "arm64", undefined]) {
        const [target] = parseAptIndexTargets(transcript, architecture);
        if (target === undefined) throw new Error("Missing APT target");
        const entry = entryForTarget(target, stanzas);
        const files = declaredPackageFiles(
          [repository],
          new Map([[description, target]]),
        );
        if (architecture === "amd64")
          expect(entry).toMatchObject({ uri, suite, components: [] });
        else expect(entry).toBeUndefined();
        // Recorded replay facts need no second expansion against host settings.
        expect(files).toEqual(new Set([description]));
      }
    },
  );
});

describe("APT architecture tokens and saturated ports", () => {
  it("matches an x86_64 $(ARCH) template to APT's expanded URI and release", () => {
    const uri = "https://vendor.invalid/archive/$(ARCH)";
    const suite = "stable/binary-$(ARCH)/";
    const stanzas = parseDeb822Sources(
      `Types: deb\nURIs: ${uri}\nSuites: ${suite}\nComponents: main\n`,
      deb822LookupFile,
    );
    const repoUri = "https://vendor.invalid/archive/x86_64/";
    const release = "stable/binary-x86_64/";
    const transcript = [
      `Description: ${repoUri.slice(0, -1)} ${release} Packages`,
      "Filename: /var/lib/apt/lists/vendor",
      `Base-URI: ${repoUri}${release}`,
      `Repo-URI: ${repoUri}`,
      `Release: ${release}`,
      `Sourcesentry: ${deb822LookupFile}:1`,
    ].join("\n");
    const [target] = parseAptIndexTargets(transcript, "x86_64");
    if (target === undefined) throw new Error("Missing APT target");
    expect(entryForTarget(target, stanzas)).toEqual({
      file: deb822LookupFile,
      position: 1,
      uri,
      credentials: false,
      suite,
      components: [],
      architectures: [],
      signedBy: [],
      inlineKey: null,
    });
    const [unconfigured] = parseAptIndexTargets(transcript);
    if (unconfigured === undefined) throw new Error("Missing APT target");
    expect(entryForTarget(unconfigured, stanzas)).toBeUndefined();
  });

  it.each([
    ["decimal", "80", "80"],
    ["trailing junk", "80abc", "80"],
    ["non-numeric", "https", ""],
    ["leading zeros", "0080", "80"],
    ["long leading zeros", `${"0".repeat(5000)}80`, "80"],
    ["long positive", "9".repeat(5000), "4294967295"],
    ["long negative", `-${"9".repeat(5000)}`, ""],
    ["long positive sign and junk", `+${"9".repeat(5000)}abc`, "4294967295"],
    ["signed maximum", "9223372036854775807", "4294967295"],
    ["one past signed maximum", "9223372036854775808", "4294967295"],
    ["signed minimum", "-9223372036854775808", ""],
    ["one above signed minimum", "-9223372036854775807", "1"],
    ["negative wrap", "-80", "4294967216"],
  ] as const)(
    "maps a %s port suffix to APT's unsigned port",
    (_kind, suffix, port) => {
      const authored = `https://vendor.invalid:${suffix}/archive`;
      const repoUri =
        port === ""
          ? "https://vendor.invalid/archive/"
          : `https://vendor.invalid:${port}/archive/`;
      const stanzas = parseDeb822Sources(
        `Types: deb\nURIs: ${authored}\nSuites: stable\nComponents: main\n`,
        deb822LookupFile,
      );
      expect(entryForTarget(targetFor(repoUri), stanzas)).toEqual({
        file: deb822LookupFile,
        position: 1,
        uri: authored,
        credentials: false,
        suite: "stable",
        components: ["main"],
        architectures: [],
        signedBy: [],
        inlineKey: null,
      });
    },
  );
});

describe("empty-authority file URIs", () => {
  it("accepts file:// when its Packages index is present and keeps the authored URI and suite", () => {
    const uri = "file://";
    const suite = "stable";
    const stanzas = parseDeb822Sources(
      `Types: deb\nURIs: ${uri}\nSuites: ${suite}\nComponents: main\n`,
      deb822LookupFile,
    );
    const transcript = [
      "Description: file:/ stable/main amd64 Packages",
      "Filename: /var/lib/apt/lists/dists_stable_main_binary-amd64_Packages",
      "Base-URI: file://dists/stable/",
      "Repo-URI: file://",
      "Release: stable",
      "Component: main",
      "Created-By: Packages",
      `Sourcesentry: ${deb822LookupFile}:1`,
    ].join("\n");
    const [target] = parseAptIndexTargets(transcript);
    if (target === undefined) throw new Error("Missing APT target");
    expect(target).toMatchObject({
      repoUri: "file://",
      release: "stable",
      component: "main",
    });
    expect(entryForTarget(target, stanzas)).toEqual({
      file: deb822LookupFile,
      position: 1,
      uri,
      credentials: false,
      suite,
      components: ["main"],
      architectures: [],
      signedBy: [],
      inlineKey: null,
    });
  });
});

describe("APT scheme:host shorthand", () => {
  it.each([
    ["http:127.0.0.1:18743/archive", "http://127.0.0.1:18743/archive/"],
    ["http:[::1]:18743/archive", "http://[::1]:18743/archive/"],
    ["https:vendor.invalid:/archive", "https://vendor.invalid/archive/"],
    ["copy:/srv/repo", "copy:/srv/repo/"],
  ])(
    "matches shorthand %s to APT's Repo-URI and keeps the authored URI",
    (authored, repoUri) => {
      const stanzas = parseDeb822Sources(
        `Types: deb\nURIs: ${authored}\nSuites: stable\nComponents: main\n`,
        deb822LookupFile,
      );
      expect(entryForTarget(targetFor(repoUri), stanzas)).toEqual({
        file: deb822LookupFile,
        position: 1,
        uri: authored,
        credentials: false,
        suite: "stable",
        components: ["main"],
        architectures: [],
        signedBy: [],
        inlineKey: null,
      });
      const untouched = authored.endsWith("/") ? authored : `${authored}/`;
      if (untouched !== repoUri)
        expect(entryForTarget(targetFor(untouched), stanzas)).toBeUndefined();
    },
  );

  it("reads a long bracketed host in one pass and keeps the authored URI", () => {
    const repeats = 16_384;
    const authored = `https://${"[a]".repeat(repeats)}:18743/archive`;
    const repoUri = `https://${"a".repeat(repeats)}:18743/archive/`;
    const stanzas = parseDeb822Sources(
      `Types: deb\nURIs: ${authored}\nSuites: stable\nComponents: main\n`,
      deb822LookupFile,
    );
    expect(entryForTarget(targetFor(repoUri), stanzas)).toEqual({
      file: deb822LookupFile,
      position: 1,
      uri: authored,
      credentials: false,
      suite: "stable",
      components: ["main"],
      architectures: [],
      signedBy: [],
      inlineKey: null,
    });
  });
});

describe("APT source URI lookup", () => {
  it("matches APT's deb822 Repo-URI spellings without changing the source URI", () => {
    const stanzas = parseDeb822Sources(
      [
        "Types: deb",
        "URIs: file:///srv/a%20b copy:/srv/repo https://vendor.invalid:00080/archive https://empty.invalid:/archive https://[2001:db8::11]:08443/apt file:/srv/double//",
        "Suites: stable",
        "Components: main",
      ].join("\n"),
      deb822LookupFile,
    );

    // Repo-URI values from apt-get indextargets --no-release-info (APT 3.2.0).
    const spellings = [
      ["file:/srv/a%20b/", "file:///srv/a%20b"],
      ["copy:/srv/repo/", "copy:/srv/repo"],
      ["https://empty.invalid/archive/", "https://empty.invalid:/archive"],
      [
        "https://vendor.invalid:80/archive/",
        "https://vendor.invalid:00080/archive",
      ],
      ["https://[2001:db8::11]:8443/apt/", "https://[2001:db8::11]:08443/apt"],
      ["file:/srv/double//", "file:/srv/double//"],
    ] as const;
    for (const [repoUri, uri] of spellings) {
      expect(entryForTarget(targetFor(repoUri), stanzas)).toMatchObject({
        uri,
      });
    }
    expect(
      entryForTarget(targetFor("file:/srv/a b/"), stanzas),
    ).toBeUndefined();
    expect(
      entryForTarget(targetFor("file:/srv/double/"), stanzas),
    ).toBeUndefined();
  });

  it.each(["before the stanza", "inside the stanza"])(
    "ignores an undecodable deb822 comment %s",
    (where) => {
      const comment = Buffer.from("# comment \xff\n", "latin1");
      const fields = Buffer.from(
        "URIs: https://good.invalid/archive\nSuites: stable\nComponents: main\n",
      );
      const types = Buffer.from("Types: deb\n");
      const source =
        where === "before the stanza"
          ? Buffer.concat([comment, Buffer.from("\n"), types, fields])
          : Buffer.concat([types, comment, fields]);
      const stanzas = parseDeb822Sources(source, deb822LookupFile);
      expect(stanzas).toHaveLength(1);
      expect(
        entryForTarget(targetFor("https://good.invalid/archive/"), stanzas),
      ).toMatchObject({ position: 1, uri: "https://good.invalid/archive" });
    },
  );

  it("keeps the position of a valid stanza after undecodable source bytes", () => {
    const declaration = (host: string) =>
      `Types: deb\nURIs: https://${host}/archive\nSuites: stable\nComponents: main\n`;
    const source = Buffer.concat([
      Buffer.from(declaration("bad.invalid/ÿ"), "latin1"),
      Buffer.from(`\n${declaration("good.invalid")}`),
    ]);
    const stanzas = parseDeb822Sources(source, deb822LookupFile);
    expect(stanzas).toHaveLength(1);
    expect(
      entryForTarget(
        { ...targetFor("https://good.invalid/archive/"), position: 2 },
        stanzas,
      ),
    ).toMatchObject({ uri: "https://good.invalid/archive" });
  });

  it("leaves different authored URIs that APT collapses unresolved", () => {
    const stanzas = parseDeb822Sources(
      [
        "Types: deb",
        "URIs: file:/srv/a%20b file:///srv/a%20b",
        "Suites: stable",
        "Components: main",
      ].join("\n"),
      deb822LookupFile,
    );

    expect(
      entryForTarget(targetFor("file:/srv/a%20b/"), stanzas),
    ).toBeUndefined();
  });

  it("attributes package indexes only when the deb822 declaration reproduces the observed Repo-URI", () => {
    const source = "https://vendor.invalid/a,b stable/main amd64 Packages";
    const sibling = "https://vendor.invalid/a,b stable/contrib amd64 Packages";
    const repoUri = "https://vendor.invalid/a,b/";
    const unrelated = "https://vendor.invalid/a%2Cb/";
    const list = "/etc/apt/sources.list.d/vendor.list";
    const stanzas = parseOneLineSources(
      "deb https://vendor.invalid/a%2Cb stable main contrib",
      list,
    );
    const index = { ...targetFor(repoUri, source), sourcesFile: list };
    const targets = new Map(
      [
        index,
        targetFor(repoUri, sibling, "contrib"),
        targetFor(unrelated),
        { ...targetFor(repoUri, "other release"), release: "testing" },
      ].map((target) => [target.description, target]),
    );
    const entry = entryForTarget(index, stanzas);
    expect(entry?.uri).toBe("https://vendor.invalid/a%2Cb");
    if (entry === undefined) throw new Error("missing source entry");
    const repository = {
      source,
      uri: entry.uri,
      suite: entry.suite,
      components: [...entry.components],
    };

    expect([...declaredPackageFiles([repository], targets)]).toEqual([]);
    expect([
      ...declaredPackageFiles(
        [{ ...repository, repo_uri: repoUri, sources_file: list }],
        targets,
      ),
    ]).toEqual([source, sibling]);
    expect([
      ...declaredPackageFiles(
        [{ ...repository, source: "unobserved" }],
        targets,
      ),
    ]).toEqual([]);
  });
});

it("matches APT's deb822 URI and suite without splitting non-ASCII whitespace", () => {
  const file = "/etc/apt/sources.list.d/spacing.sources";
  const uri = "https://vendor.invalid/a\u00a0b";
  const suite = "stable\u00a0testing/";
  const mirror = "https://mirror.invalid/archive";
  const stanzas = parseDeb822Sources(
    `Types: deb\nURIs: ${uri}\t ${mirror}\nSuites: ${suite} fallback/\n`,
    file,
  );
  // Offline indextargets preserves the NBSP bytes, but splits the ASCII tab.
  for (const [repoUri, release] of [
    [uri, suite],
    [mirror, "fallback/"],
  ] as const) {
    const [target] = parseAptIndexTargets(
      [
        `Description: ${repoUri} ${release} Packages`,
        "Filename: /var/lib/apt/lists/vendor",
        `Base-URI: ${repoUri}/${release}`,
        `Repo-URI: ${repoUri}/`,
        `Release: ${release}`,
        `Sourcesentry: ${file}:1`,
      ].join("\n"),
    );
    if (target === undefined) throw new Error("Missing APT target");
    expect(entryForTarget(target, stanzas)).toMatchObject({
      uri: repoUri,
      suite: release,
      components: [],
    });
  }
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

    expect(stanzas.map(({ uris }) => uris)).toEqual([
      [{ uri: "https://apt.example.com/repo/", credentials: true }],
      [{ uri: "https://apt.example.com/user-only", credentials: true }],
      [{ uri: "https://apt.example.com/at-sign", credentials: true }],
      [{ uri: "https://apt.example.com/open", credentials: false }],
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
          { uri: "https://apt.example.com/repo/", credentials: true },
          { uri: "https://mirror.example.com/repo", credentials: true },
          { uri: "https://open.example.com/repo", credentials: false },
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
              source: description,
              uri: "https://apt.example.com/repo",
              suite: "stable",
              components: ["main"],
            },
          ],
          new Map([[description, target]]),
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

it("keeps APT's source positions when a false Enabled field disables a stanza", () => {
  const source = (enabled: string) =>
    `Types: deb\nURIs: https://example.org/repo\nSuites: stable\nComponents: main\nEnabled: ${enabled}\n`;
  const disabled = [
    "false",
    "0",
    "Off",
    "without",
    "disable",
    "+0",
    "-0",
    "0x0",
    "-0x0",
    "\tFaLsE \t",
    "\n false",
    "\n\t-0",
  ];
  const enabled = [
    "yes",
    "1",
    "0x1",
    "-1",
    "0.0",
    "fal\u017fe",
    "\u00a0false",
    "false\u00a0",
    "\u3000FaLsE\u3000",
    "\n\tfalse",
    "\n\r \n false",
    "\n\r false",
  ];
  const stanzas = parseDeb822Sources(
    Buffer.from([...disabled, ...enabled].map(source).join("\n")),
    "example.sources",
  );
  expect(stanzas.map((entry) => entry.position)).toEqual(
    enabled.map((_, index) => disabled.length + index + 1),
  );
});

it.each([
  ["amd64 arm64", "i386 amd64", "arm64", ["amd64", "i386"]],
  ["amd64", "arm64 i386 i386", "arm64", ["amd64", "i386"]],
  ["amd64", "", "amd64", ["all"]],
  ["", "i386", "arm64", []],
] as const)(
  "reads the explicit architecture list %s with additions %s and removals %s",
  (base, add, remove, expected) => {
    const fields = [
      "Types: deb",
      "URIs: file:/repo",
      "Suites: stable",
      "Components: main",
      ...(base ? [`Architectures: ${base}`] : []),
      ...(add ? [`Architectures-Add: ${add}`] : []),
      `Architectures-Remove: ${remove}`,
    ];
    const options = [
      ...(base ? [`arch=${base.replaceAll(" ", ",")}`] : []),
      `arch-=${remove}`,
      ...(add ? [`arch+=${add.replaceAll(" ", ",")}`] : []),
    ];
    expect(
      parseDeb822Sources(fields.join("\n"), "vendor.sources")[0]?.architectures,
    ).toEqual(expected);
    expect(
      parseOneLineSources(
        `deb [${options.join(" ")}] file:/repo stable main`,
        "vendor.list",
      )[0]?.architectures,
    ).toEqual(expected);
  },
);

it.each([
  ["space", " ", "\n"],
  ["tab", "\t", "\n"],
  ["space before CRLF", " ", "\r\n"],
])(
  "keeps a %s-only continuation inside its deb822 source",
  (_name, indent, eol) => {
    const text = [
      "Types: deb",
      "URIs: https://disabled.invalid/deb",
      "Suites: stable",
      "Components: main",
      indent,
      "Enabled: no",
      "",
      "Types: deb",
      "URIs: https://active.invalid/deb",
      "Suites: next",
      "Components: main",
      "",
    ].join(eol);
    const stanzas = parseDeb822Sources(Buffer.from(text), "local.sources");
    expect(
      stanzas.map(({ position, suites }) => ({ position, suites })),
    ).toEqual([{ position: 2, suites: ["next"] }]);
  },
);

it("reads a CR-led field and preserves a CR-only paragraph separator", () => {
  const source = [
    "Types: deb",
    "URIs: https://disabled.invalid/deb",
    "Suites: stable",
    "Components: main",
    "\rEnabled: no",
    "\r",
    "Types: deb",
    "URIs: https://active.invalid/deb",
    "Suites: stable",
    "Components: main",
    "",
  ].join("\n");
  const stanzas = parseDeb822Sources(Buffer.from(source), "local.sources");
  expect(stanzas.map(({ position }) => position)).toEqual([2]);
});

it.each([1, 65_536])(
  "preserves %i interior blank continuations but trims trailing ones",
  (interiorBlanks) => {
    const [fields] = deb822Paragraphs(
      `Name: first\n${" \n".repeat(interiorBlanks)} second\n\t\nOther: value\n`,
    );
    expect(fields?.get("name")).toBe(
      `first${"\n".repeat(interiorBlanks + 1)}second`,
    );
    expect(fields?.get("other")).toBe("value");
  },
);

it("filters out deb822 stanzas disabled with Enabled: false, no, or 0 while keeping enabled and implicitly enabled stanzas", () => {
  const multiStanzaSources = [
    // Stanza 1: Enabled: false (explicitly disabled)
    "Types: deb",
    "URIs: https://example.org/disabled-false",
    "Suites: stable",
    "Components: main",
    "Enabled: false",
    "",
    // Stanza 2: Implicitly enabled (Enabled field omitted)
    "Types: deb",
    "URIs: https://example.org/implicitly-enabled",
    "Suites: stable",
    "Components: main",
    "",
    // Stanza 3: Explicitly enabled with true
    "Types: deb",
    "URIs: https://example.org/enabled-true",
    "Suites: stable",
    "Components: main",
    "Enabled: true",
    "",
    // Stanza 4: Explicitly disabled with case-insensitive No
    "Types: deb",
    "URIs: https://example.org/disabled-no",
    "Suites: stable",
    "Components: main",
    "Enabled: No",
    "",
    // Stanza 5: Explicitly enabled with 1
    "Types: deb",
    "URIs: https://example.org/enabled-one",
    "Suites: stable",
    "Components: main",
    "Enabled: 1",
    "",
    // Stanza 6: Explicitly enabled with yes
    "Types: deb",
    "URIs: https://example.org/enabled-yes",
    "Suites: stable",
    "Components: main",
    "Enabled: yes",
    "",
    // Stanza 7: Explicitly disabled with 0
    "Types: deb",
    "URIs: https://example.org/disabled-zero",
    "Suites: stable",
    "Components: main",
    "Enabled: 0",
    "",
  ].join("\n");

  const stanzas = parseDeb822Sources(multiStanzaSources, "multi.sources");
  expect(
    stanzas.map((entry) => ({
      position: entry.position,
      uri: entry.uris[0]?.uri,
    })),
  ).toEqual([
    { position: 2, uri: "https://example.org/implicitly-enabled" },
    { position: 3, uri: "https://example.org/enabled-true" },
    { position: 5, uri: "https://example.org/enabled-one" },
    { position: 6, uri: "https://example.org/enabled-yes" },
  ]);
});
