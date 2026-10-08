import { describe, expect, it } from "vitest";

import {
  traceDylibLoading,
  type DylibSharedCacheView,
  type DylibTreeEntry,
  type DylibTreeView,
  type MachoDependency,
  type MachoImageFacts,
  type MachoSlice,
} from "./dylibResolution.js";

const slice = (overrides: Partial<MachoSlice> = {}): MachoSlice => ({
  architecture: "arm64",
  file_type: "dylib",
  install_name: null,
  dependencies: [],
  rpaths: [],
  dyld_environment: [],
  code_signature_present: true,
  platforms: [{ id: 1, name: "macos" }],
  ...overrides,
});

const dependency = (
  installName: string,
  overrides: Partial<MachoDependency> = {},
): MachoDependency => ({
  command: "LC_LOAD_DYLIB",
  encoding: "dylib_command",
  install_name: installName,
  weak: false,
  upward: false,
  reexport: false,
  delayed_init: false,
  current_version: "1.0.0",
  compatibility_version: "1.0.0",
  ...overrides,
});

const parsed = (...slices: MachoSlice[]): MachoImageFacts => ({
  status: "parsed",
  slices,
});

const executable = (overrides: Partial<MachoSlice> = {}): MachoImageFacts =>
  parsed(slice({ file_type: "execute", ...overrides }));

/** In-memory tree: files are images (or "data"), symlinks map to targets. */
const memoryView = (
  files: Readonly<Record<string, MachoImageFacts | "data">>,
  symlinks: Readonly<Record<string, string>> = {},
): DylibTreeView => {
  const entries = new Map<string, DylibTreeEntry>();
  const addParents = (path: string): void => {
    const segments = path.split("/");
    for (let length = 1; length < segments.length; length++)
      entries.set(segments.slice(0, length).join("/"), { kind: "directory" });
  };
  for (const path of Object.keys(files)) {
    addParents(path);
    entries.set(path, { kind: "file" });
  }
  for (const [path, target] of Object.entries(symlinks)) {
    addParents(path);
    entries.set(path, { kind: "symlink", target });
  }
  return {
    entry: (path) => Promise.resolve(entries.get(path)),
    image: (path) => {
      const facts = files[path];
      return Promise.resolve(
        facts === undefined || facts === "data"
          ? { status: "not-mach-o" as const }
          : facts,
      );
    },
  };
};

const MAIN = "Contents/MacOS/App";

const edgeFor = (
  trace: Awaited<ReturnType<typeof traceDylibLoading>>,
  loader: string,
  installName: string,
) => {
  const edge = trace.edges.find(
    (candidate) =>
      candidate.loader === loader && candidate.install_name === installName,
  );
  if (edge === undefined)
    throw new Error(`missing ${loader} -> ${installName}`);
  return edge;
};

describe("dyld path expansion", () => {
  it("searches the loading image's rpaths before its loaders'", async () => {
    const core = "Contents/Frameworks/Core.framework/Versions/A/Core";
    const trace = await traceDylibLoading(
      memoryView({
        [MAIN]: executable({
          rpaths: ["@executable_path/../Frameworks"],
          dependencies: [dependency("@rpath/Core.framework/Versions/A/Core")],
        }),
        [core]: parsed(
          slice({
            rpaths: ["@loader_path/Libraries"],
            dependencies: [dependency("@rpath/libchain.dylib")],
          }),
        ),
        "Contents/Frameworks/libchain.dylib": parsed(slice()),
        "Contents/Frameworks/Core.framework/Versions/A/Libraries/libchain.dylib":
          parsed(slice()),
      }),
      { roots: [MAIN] },
    );
    const chain = edgeFor(trace, core, "@rpath/libchain.dylib");
    expect(chain.via).toEqual([MAIN, core]);
    expect(chain.candidates).toEqual([
      expect.objectContaining({
        source: "rpath",
        rpath: "@loader_path/Libraries",
        rpath_owner: core,
        outcome: "resolved",
      }),
    ]);
    expect(chain.resolution).toEqual({
      status: "resolved",
      image:
        "Contents/Frameworks/Core.framework/Versions/A/Libraries/libchain.dylib",
    });
  });

  it("expands @loader_path in an rpath relative to the image that owns it", async () => {
    const plugin = "Contents/PlugIns/Tool.bundle/Contents/MacOS/Tool";
    const trace = await traceDylibLoading(
      memoryView({
        [MAIN]: executable({
          rpaths: ["@loader_path/../Shared"],
          dependencies: [
            dependency(
              `@executable_path/../PlugIns/Tool.bundle/Contents/MacOS/Tool`,
            ),
          ],
        }),
        [plugin]: parsed(
          slice({
            file_type: "bundle",
            dependencies: [dependency("@rpath/libshared.dylib")],
          }),
        ),
        "Contents/Shared/libshared.dylib": parsed(slice()),
      }),
      { roots: [MAIN] },
    );
    expect(edgeFor(trace, plugin, "@rpath/libshared.dylib").candidates).toEqual(
      [
        expect.objectContaining({
          path: "Contents/MacOS/../Shared/libshared.dylib",
          rpath_owner: MAIN,
          outcome: "resolved",
          resolved_path: "Contents/Shared/libshared.dylib",
        }),
      ],
    );
  });

  it("gives each executable root its own @executable_path", async () => {
    const service = "Contents/XPCServices/Fetch.xpc/Contents/MacOS/Fetch";
    const trace = await traceDylibLoading(
      memoryView({
        [MAIN]: executable({
          dependencies: [dependency("@executable_path/libhere.dylib")],
        }),
        [service]: executable({
          dependencies: [dependency("@executable_path/libhere.dylib")],
        }),
        "Contents/MacOS/libhere.dylib": parsed(slice()),
      }),
      { roots: [MAIN, service] },
    );
    expect(
      edgeFor(trace, MAIN, "@executable_path/libhere.dylib").resolution.status,
    ).toBe("resolved");
    expect(
      edgeFor(trace, service, "@executable_path/libhere.dylib"),
    ).toMatchObject({
      candidates: [
        {
          path: "Contents/XPCServices/Fetch.xpc/Contents/MacOS/libhere.dylib",
          outcome: "absent",
        },
      ],
      resolution: { status: "unresolved", image: null },
    });
  });

  it("follows Versions/Current inside the root and stops at escaping links", async () => {
    const trace = await traceDylibLoading(
      memoryView(
        {
          [MAIN]: executable({
            rpaths: ["@executable_path/../Frameworks"],
            dependencies: [
              dependency("@rpath/Core.framework/Core"),
              dependency("@rpath/Escape.framework/Escape"),
              dependency("@executable_path/../../../outside.dylib"),
            ],
          }),
          "Contents/Frameworks/Core.framework/Versions/A/Core": parsed(slice()),
        },
        {
          "Contents/Frameworks/Core.framework/Versions/Current": "A",
          "Contents/Frameworks/Core.framework/Core": "Versions/Current/Core",
          "Contents/Frameworks/Escape.framework":
            "/Library/Frameworks/Escape.framework",
        },
      ),
      { roots: [MAIN] },
    );
    expect(
      edgeFor(trace, MAIN, "@rpath/Core.framework/Core").resolution,
    ).toEqual({
      status: "resolved",
      image: "Contents/Frameworks/Core.framework/Versions/A/Core",
    });
    for (const name of [
      "@rpath/Escape.framework/Escape",
      "@executable_path/../../../outside.dylib",
    ])
      expect(edgeFor(trace, MAIN, name)).toMatchObject({
        candidates: [{ outcome: "escapes-target" }],
        resolution: { status: "undetermined", image: null },
      });
  });
});

describe("dyld resolution outcomes", () => {
  it("keeps paths outside the root undetermined and in-root fallbacks conditional", async () => {
    const trace = await traceDylibLoading(
      memoryView({
        [MAIN]: executable({
          rpaths: ["/usr/lib/swift", "@executable_path/../Frameworks"],
          dependencies: [
            dependency("/usr/lib/libSystem.B.dylib"),
            dependency("@rpath/libswiftCore.dylib"),
            dependency("libleaf.dylib"),
          ],
        }),
        "Contents/Frameworks/libswiftCore.dylib": parsed(slice()),
      }),
      { roots: [MAIN] },
    );
    expect(edgeFor(trace, MAIN, "/usr/lib/libSystem.B.dylib")).toMatchObject({
      candidates: [
        { outcome: "outside-target", path: "/usr/lib/libSystem.B.dylib" },
      ],
      resolution: { status: "undetermined", image: null },
    });
    expect(edgeFor(trace, MAIN, "@rpath/libswiftCore.dylib")).toMatchObject({
      candidates: [
        {
          outcome: "outside-target",
          path: "/usr/lib/swift/libswiftCore.dylib",
        },
        { outcome: "resolved" },
      ],
      resolution: {
        status: "conditional",
        image: "Contents/Frameworks/libswiftCore.dylib",
      },
    });
    expect(edgeFor(trace, MAIN, "libleaf.dylib").resolution.status).toBe(
      "undetermined",
    );
  });

  it("derives unresolved and earlier-candidate findings separately for weak loads", async () => {
    const trace = await traceDylibLoading(
      memoryView({
        [MAIN]: executable({
          rpaths: [
            "@executable_path/../Overrides",
            "@executable_path/../Frameworks",
          ],
          dependencies: [
            dependency("@rpath/libfound.dylib"),
            dependency("@rpath/libgone.dylib", {
              command: "LC_LOAD_WEAK_DYLIB",
              weak: true,
            }),
            dependency("@rpath/libmissing.dylib"),
          ],
          dyld_environment: ["DYLD_LIBRARY_PATH=/tmp"],
        }),
        "Contents/Frameworks/libfound.dylib": parsed(slice()),
      }),
      { roots: [MAIN] },
    );
    expect(
      trace.findings.map(({ kind, edge_index: index }) => [kind, index]),
    ).toEqual([
      ["earlier-rpath-candidate-absent", 0],
      ["weak-load-unresolved", 1],
      ["required-load-unresolved", 2],
      ["dyld-environment-present", null],
    ]);
    expect(trace.findings[0]?.explanation).toContain(
      "Contents/MacOS/../Overrides/libfound.dylib",
    );
  });

  it("reports non-Mach-O, malformed and wrong-architecture candidates", async () => {
    const trace = await traceDylibLoading(
      memoryView({
        [MAIN]: executable({
          rpaths: [
            "@executable_path/a",
            "@executable_path/b",
            "@executable_path/c",
          ],
          dependencies: [dependency("@rpath/lib.dylib")],
        }),
        "Contents/MacOS/a/lib.dylib": "data",
        "Contents/MacOS/b/lib.dylib": {
          status: "malformed",
          reason: "load command 0 has invalid cmdsize 0",
        },
        "Contents/MacOS/c/lib.dylib": parsed(slice({ architecture: "x86_64" })),
      }),
      { roots: [MAIN] },
    );
    expect(
      edgeFor(trace, MAIN, "@rpath/lib.dylib").candidates.map(
        ({ outcome }) => outcome,
      ),
    ).toEqual(["not-mach-o", "malformed", "architecture-missing"]);
    expect(trace.coverage).toEqual({
      status: "partial",
      unparsed_images: ["Contents/MacOS/b/lib.dylib"],
      roots_without_architecture: [],
      unverified_shared_cache_images: [],
    });
    expect(trace.images.map(({ path }) => path)).toEqual([
      MAIN,
      "Contents/MacOS/b/lib.dylib",
      "Contents/MacOS/c/lib.dylib",
    ]);
  });
});

describe("dyld load order", () => {
  it("loads each image once per process and reuses matching install names", async () => {
    const a = "Contents/Frameworks/libA.dylib";
    const b = "Contents/Frameworks/libB.dylib";
    const trace = await traceDylibLoading(
      memoryView({
        [MAIN]: executable({
          rpaths: ["@executable_path/../Frameworks"],
          dependencies: [
            dependency("@rpath/libA.dylib"),
            dependency("@rpath/libB.dylib"),
          ],
        }),
        [a]: parsed(
          slice({
            install_name: "@rpath/libA.dylib",
            dependencies: [
              dependency("@rpath/libB.dylib"),
              dependency("@rpath/libA.dylib"),
            ],
          }),
        ),
        [b]: parsed(
          slice({
            install_name: "@rpath/libB.dylib",
            dependencies: [dependency("@rpath/libA.dylib")],
          }),
        ),
      }),
      { roots: [MAIN] },
    );
    expect(
      trace.edges.map(
        ({ loader, install_name: name }) =>
          `${loader.split("/").at(-1)}>${name}`,
      ),
    ).toEqual([
      "App>@rpath/libA.dylib",
      "App>@rpath/libB.dylib",
      "libA.dylib>@rpath/libB.dylib",
      "libA.dylib>@rpath/libA.dylib",
      "libB.dylib>@rpath/libA.dylib",
    ]);
    expect(edgeFor(trace, b, "@rpath/libA.dylib").candidates).toEqual([
      expect.objectContaining({ source: "already-loaded", resolved_path: a }),
    ]);
    expect(edgeFor(trace, a, "@rpath/libA.dylib").install_name_matches).toBe(
      true,
    );
  });

  it("leaves @executable_path undetermined for a library root and filters architectures", async () => {
    const library = "Contents/Frameworks/libroot.dylib";
    const trace = await traceDylibLoading(
      memoryView({
        [library]: parsed(
          slice({ dependencies: [dependency("@executable_path/x.dylib")] }),
        ),
        [MAIN]: executable(),
      }),
      { roots: [library, MAIN], architecture: "x86_64" },
    );
    expect(trace.roots).toEqual([]);
    expect(trace.coverage.roots_without_architecture).toEqual([library, MAIN]);
    const arm = await traceDylibLoading(
      memoryView({
        [library]: parsed(
          slice({ dependencies: [dependency("@executable_path/x.dylib")] }),
        ),
      }),
      { roots: [library] },
    );
    expect(arm.edges[0]?.candidates).toEqual([
      expect.objectContaining({
        source: "executable_path",
        outcome: "undetermined",
      }),
    ]);
  });

  it("stops when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      traceDylibLoading(memoryView({ [MAIN]: executable() }), {
        roots: [MAIN],
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});

describe("dyld slice compatibility and coverage", () => {
  it("lets an x86_64h process load generic x86_64 but not arm64e load arm64", async () => {
    const files = {
      [MAIN]: parsed(
        slice({
          architecture: "x86_64h",
          file_type: "execute",
          dependencies: [dependency("@executable_path/libgeneric.dylib")],
        }),
        slice({
          architecture: "arm64e",
          file_type: "execute",
          dependencies: [dependency("@executable_path/libgeneric.dylib")],
        }),
      ),
      "Contents/MacOS/libgeneric.dylib": parsed(
        slice({ architecture: "x86_64" }),
        slice({ architecture: "arm64" }),
      ),
    };
    const trace = await traceDylibLoading(memoryView(files), { roots: [MAIN] });
    expect(
      trace.edges.map(({ architecture, candidates, resolution }) => [
        architecture,
        candidates[0]?.outcome,
        resolution.status,
      ]),
    ).toEqual([
      ["x86_64h", "resolved", "resolved"],
      ["arm64e", "architecture-missing", "unresolved"],
    ]);
  });

  it("keeps unsupported candidates undeterminable rather than malformed", async () => {
    const trace = await traceDylibLoading(
      memoryView({
        [MAIN]: executable({
          dependencies: [dependency("@executable_path/libbig.dylib")],
        }),
        "Contents/MacOS/libbig.dylib": {
          status: "unsupported",
          reason: "big-endian Mach-O images are not supported",
        },
      }),
      { roots: [MAIN] },
    );
    expect(trace.edges[0]).toMatchObject({
      candidates: [{ outcome: "unsupported" }],
      resolution: { status: "undetermined", image: null },
    });
    expect(
      trace.images.find(({ path }) => path.endsWith("libbig.dylib")),
    ).toMatchObject({
      parse_status: "unsupported",
    });
  });

  it("reports unclassified Mach-O files as partial coverage", async () => {
    const broken = "Contents/Helpers/broken";
    const trace = await traceDylibLoading(
      memoryView({
        [MAIN]: executable(),
        [broken]: {
          status: "malformed",
          reason: "load command 0 has invalid cmdsize 0",
        },
      }),
      { roots: [MAIN], unclassified: [broken] },
    );
    expect(trace.coverage).toEqual({
      status: "partial",
      unparsed_images: [broken],
      roots_without_architecture: [],
      unverified_shared_cache_images: [],
    });
    expect(trace.images.find(({ path }) => path === broken)?.reason).toBe(
      "load command 0 has invalid cmdsize 0",
    );
  });
});

/** A macOS arm64e cache that lists libSystem and libswiftCore. */
const cache = (
  overrides: Partial<DylibSharedCacheView> = {},
): DylibSharedCacheView => ({
  architecture: "arm64e",
  platforms: [
    { id: 1, name: "macos" },
    { id: 6, name: "maccatalyst" },
  ],
  unavailableSubcaches: [],
  lookup: (path: string) =>
    [
      "/usr/lib/libSystem.B.dylib",
      "/usr/lib/swift/libswiftCore.dylib",
    ].includes(path)
      ? "mapped"
      : "absent",
  image: () => Promise.resolve(parsed(slice())),
  ...overrides,
});

describe("shared cache resolution", () => {
  it("resolves cached system paths before bundled fallbacks", async () => {
    const trace = await traceDylibLoading(
      memoryView({
        [MAIN]: executable({
          rpaths: ["/usr/lib/swift", "@executable_path/../Frameworks"],
          dependencies: [
            dependency("/usr/lib/libSystem.B.dylib"),
            dependency("@rpath/libswiftCore.dylib"),
            dependency("/usr/lib/libgone.dylib"),
          ],
        }),
        "Contents/Frameworks/libswiftCore.dylib": parsed(slice()),
      }),
      { roots: [MAIN], sharedCache: cache() },
    );
    expect(
      trace.edges.map(({ install_name: name, resolution, candidates }) => [
        name,
        resolution,
        candidates.map(({ outcome }) => outcome),
      ]),
    ).toEqual([
      [
        "/usr/lib/libSystem.B.dylib",
        { status: "shared-cache", image: "/usr/lib/libSystem.B.dylib" },
        ["shared-cache"],
      ],
      [
        "@rpath/libswiftCore.dylib",
        { status: "shared-cache", image: "/usr/lib/swift/libswiftCore.dylib" },
        ["shared-cache"],
      ],
      [
        "/usr/lib/libgone.dylib",
        { status: "undetermined", image: null },
        ["outside-target"],
      ],
    ]);
    expect(trace.images.map(({ path }) => path)).toEqual([MAIN]);
    expect(trace.coverage.status).toBe("complete");
    expect(trace.limitations).toContainEqual(
      expect.stringContaining("transitive dependencies were not traversed"),
    );
    expect(trace.limitations).toContainEqual(
      expect.stringContaining(
        "looked up only in the supplied dyld shared cache",
      ),
    );
    expect(trace.limitations).not.toContainEqual(
      expect.stringContaining("are not evaluated, including /System"),
    );
  });

  it("does not treat mapped bytes as a load until they parse as a compatible Mach-O", async () => {
    const root = memoryView({
      [MAIN]: executable({
        dependencies: [dependency("/usr/lib/libSystem.B.dylib")],
      }),
    });
    const notMachO = await traceDylibLoading(root, {
      roots: [MAIN],
      sharedCache: cache({
        image: () => Promise.resolve({ status: "not-mach-o" }),
      }),
    });
    expect(notMachO.edges[0]?.resolution).toEqual({
      status: "undetermined",
      image: null,
    });
    expect(notMachO.coverage).toMatchObject({
      status: "partial",
      unverified_shared_cache_images: ["/usr/lib/libSystem.B.dylib"],
    });
    expect(notMachO.images.map(({ path }) => path)).toEqual([MAIN]);
    const wrongArchitecture = await traceDylibLoading(root, {
      roots: [MAIN],
      sharedCache: cache({
        image: () => Promise.resolve(parsed(slice({ architecture: "x86_64" }))),
      }),
    });
    expect(wrongArchitecture.edges[0]?.candidates[0]?.outcome).toBe(
      "undetermined",
    );
  });

  it("keeps a cache hit conditional after an earlier undeterminable candidate", async () => {
    const trace = await traceDylibLoading(
      memoryView({
        [MAIN]: executable({
          rpaths: ["/opt/vendor/lib", "/usr/lib/swift"],
          dependencies: [dependency("@rpath/libswiftCore.dylib")],
        }),
      }),
      { roots: [MAIN], sharedCache: cache() },
    );
    expect(trace.edges[0]?.resolution).toEqual({
      status: "conditional",
      image: "/usr/lib/swift/libswiftCore.dylib",
    });
    expect(trace.edges[0]?.candidates.map(({ outcome }) => outcome)).toEqual([
      "outside-target",
      "shared-cache",
    ]);
  });
});

describe("shared cache applicability", () => {
  it("does not consult a cache for another CPU family or platform", async () => {
    const trace = await traceDylibLoading(
      memoryView({
        [MAIN]: executable({
          architecture: "x86_64",
          dependencies: [dependency("/usr/lib/libSystem.B.dylib")],
        }),
        "Contents/MacOS/Phone": executable({
          platforms: [{ id: 2, name: "ios" }],
          dependencies: [dependency("/usr/lib/libSystem.B.dylib")],
        }),
        "Contents/MacOS/Old": executable({
          platforms: [],
          dependencies: [dependency("/usr/lib/libSystem.B.dylib")],
        }),
      }),
      {
        roots: [MAIN, "Contents/MacOS/Phone", "Contents/MacOS/Old"],
        sharedCache: cache(),
      },
    );
    expect(trace.edges.map(({ candidates }) => candidates[0]?.outcome)).toEqual(
      ["outside-target", "outside-target", "outside-target"],
    );
    expect(trace.limitations).toEqual(
      expect.arrayContaining([
        `The supplied shared cache was not used for ${MAIN} (x86_64): the arm64e cache does not serve x86_64 processes. Its absolute paths stay outside-target.`,
        "The supplied shared cache was not used for Contents/MacOS/Phone (arm64): the cache serves macos and maccatalyst processes, not ios. Its absolute paths stay outside-target.",
        "The supplied shared cache was not used for Contents/MacOS/Old (arm64): the process records no LC_BUILD_VERSION or LC_VERSION_MIN platform. Its absolute paths stay outside-target.",
      ]),
    );
    const generic = await traceDylibLoading(
      memoryView({
        [MAIN]: executable({
          architecture: "arm64e",
          dependencies: [dependency("/usr/lib/libSystem.B.dylib")],
        }),
      }),
      { roots: [MAIN], sharedCache: cache({ architecture: "arm64" }) },
    );
    // A generic arm64 cache lacks the arm64e ABI.
    expect(generic.edges[0]?.candidates[0]?.outcome).toBe("outside-target");
    const unknownPlatform = await traceDylibLoading(
      memoryView({
        [MAIN]: executable({
          dependencies: [dependency("/usr/lib/libSystem.B.dylib")],
        }),
      }),
      { roots: [MAIN], sharedCache: cache({ platforms: [] }) },
    );
    expect(unknownPlatform.edges[0]?.candidates[0]?.outcome).toBe(
      "outside-target",
    );
  });

  it("leaves images in unavailable subcaches undetermined", async () => {
    const trace = await traceDylibLoading(
      memoryView({
        [MAIN]: executable({
          dependencies: [dependency("/usr/lib/libSystem.B.dylib")],
        }),
      }),
      {
        roots: [MAIN],
        sharedCache: cache({
          unavailableSubcaches: [".01 (missing)"],
          lookup: () => "unverified",
        }),
      },
    );
    expect(trace.edges[0]?.resolution).toEqual({
      status: "undetermined",
      image: null,
    });
    expect(trace.coverage).toMatchObject({
      status: "partial",
      unverified_shared_cache_images: ["/usr/lib/libSystem.B.dylib"],
    });
    expect(trace.limitations).toContainEqual(
      expect.stringContaining("Subcaches .01 (missing)"),
    );
  });

  it("states that absolute paths are not evaluated without a cache", async () => {
    const trace = await traceDylibLoading(
      memoryView({ [MAIN]: executable({}) }),
      { roots: [MAIN] },
    );
    expect(trace.limitations).toContainEqual(
      expect.stringContaining("Pass shared_cache"),
    );
  });
});

describe("lazily loaded dependencies", () => {
  it("resolves lazy loads without traversing them or reporting launch failure", async () => {
    const trace = await traceDylibLoading(
      memoryView({
        [MAIN]: executable({
          rpaths: ["@executable_path/../Frameworks"],
          dependencies: [
            dependency("@rpath/liblazy.dylib", {
              command: "LC_LAZY_LOAD_DYLIB",
            }),
            dependency("@rpath/libmissing.dylib", {
              command: "LC_LAZY_LOAD_DYLIB",
            }),
          ],
        }),
        "Contents/Frameworks/liblazy.dylib": parsed(
          slice({ dependencies: [dependency("@rpath/libdeep.dylib")] }),
        ),
      }),
      { roots: [MAIN] },
    );
    expect(trace.edges.map(({ loader }) => loader)).toEqual([MAIN, MAIN]);
    expect(trace.edges[0]?.resolution.status).toBe("resolved");
    expect(trace.findings.map(({ kind }) => kind)).toEqual([
      "lazy-load-unresolved",
    ]);
  });
});

describe("conditional loads", () => {
  it("carries a conditional fallback's uncertainty to its dependents and reuses", async () => {
    const VENDOR = "Contents/Frameworks/libvendor.dylib";
    const OTHER = "Contents/Frameworks/libother.dylib";
    const trace = await traceDylibLoading(
      memoryView({
        [MAIN]: executable({
          rpaths: ["/opt/vendor/lib", "@executable_path/../Frameworks"],
          dependencies: [
            dependency("@rpath/libvendor.dylib"),
            dependency("@executable_path/../Frameworks/libother.dylib"),
          ],
        }),
        [VENDOR]: parsed(
          slice({
            install_name: "@rpath/libvendor.dylib",
            dependencies: [
              dependency("@loader_path/libgone.dylib"),
              dependency("@loader_path/libweak.dylib", { weak: true }),
              dependency("@loader_path/liblazy.dylib", {
                command: "LC_LAZY_LOAD_DYLIB",
              }),
            ],
          }),
        ),
        [OTHER]: parsed(
          slice({ dependencies: [dependency("@rpath/libvendor.dylib")] }),
        ),
      }),
      { roots: [MAIN] },
    );
    expect(edgeFor(trace, MAIN, "@rpath/libvendor.dylib")).toMatchObject({
      resolution: { status: "conditional", image: VENDOR },
      loader_conditional: false,
    });
    expect(edgeFor(trace, VENDOR, "@loader_path/libgone.dylib")).toMatchObject({
      resolution: { status: "unresolved" },
      loader_conditional: true,
    });
    expect(edgeFor(trace, OTHER, "@rpath/libvendor.dylib")).toMatchObject({
      candidates: [{ source: "already-loaded" }],
      resolution: { status: "conditional", image: VENDOR },
      loader_conditional: false,
    });
    // Required, weak and lazy findings below the fallback are all qualified.
    for (const kind of [
      "required-load-unresolved",
      "weak-load-unresolved",
      "lazy-load-unresolved",
    ])
      expect(
        trace.findings.find((finding) => finding.kind === kind)?.explanation,
      ).toContain(`${VENDOR} loads only conditionally; if it loads,`);
  });
});
