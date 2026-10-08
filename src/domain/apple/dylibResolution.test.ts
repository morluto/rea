import { describe, expect, it } from "vitest";

import {
  traceDylibLoading,
  type DylibTreeEntry,
  type DylibTreeView,
  type MachoDependency,
  type MachoImageFacts,
  type MachoSlice,
} from "./dylibResolution.js";

const slice = (overrides: Partial<MachoSlice> = {}): MachoSlice => ({
  architecture: "arm64",
  slice_offset: 0,
  slice_size: 32,
  cpu_type: 0x0100000c,
  cpu_subtype: 0,
  fat_cpu_type: null,
  fat_cpu_subtype: null,
  fat_alignment_exponent: null,
  file_type: overrides.file_type ?? "dylib",
  file_type_code:
    overrides.file_type_code ??
    { execute: 2, dylib: 6, bundle: 8, other: 1 }[
      overrides.file_type ?? "dylib"
    ],
  platform: overrides.platform ?? 1,
  platforms:
    overrides.platforms ??
    (overrides.platform === null ? [] : [overrides.platform ?? 1]),
  install_name: null,
  dependencies: [],
  rpaths: [],
  dyld_environment: [],
  code_signature_present: true,
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
            file_type: "dylib",
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

describe("dyld resolution outcomes: deriving path and weak-load outcomes", () => {
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
      ["dyld-environment-present", null],
    ]);
    expect(trace.findings[0]?.explanation).toContain(
      "Contents/MacOS/../Overrides/libfound.dylib",
    );
    expect(trace.findings[0]?.explanation).toContain(
      "Unmodeled environment overrides",
    );
    expect(trace.coverage.status).toBe("partial");
  });
});

describe("dyld resolution outcomes: checking candidate format and compatibility", () => {
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
    });
    expect(trace.images.map(({ path }) => path)).toEqual([
      MAIN,
      "Contents/MacOS/b/lib.dylib",
      "Contents/MacOS/c/lib.dylib",
    ]);
  });

  it("skips non-loadable and wrong-platform rpath candidates", async () => {
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
        "Contents/MacOS/a/lib.dylib": parsed(
          slice({ file_type: "other", file_type_code: 1 }),
        ),
        "Contents/MacOS/b/lib.dylib": parsed(slice({ platform: 7 })),
        "Contents/MacOS/c/lib.dylib": parsed(slice()),
      }),
      { roots: [MAIN] },
    );
    const edge = edgeFor(trace, MAIN, "@rpath/lib.dylib");
    expect(edge.candidates.map(({ outcome }) => outcome)).toEqual([
      "not-loadable",
      "platform-mismatch",
      "resolved",
    ]);
    expect(edge.resolution).toEqual({
      status: "resolved",
      image: "Contents/MacOS/c/lib.dylib",
    });
  });

  it("preserves unknown platform compatibility before a later known candidate", async () => {
    const trace = await traceDylibLoading(
      memoryView({
        [MAIN]: executable({
          rpaths: ["@executable_path/a", "@executable_path/b"],
          dependencies: [dependency("@rpath/lib.dylib")],
        }),
        "Contents/MacOS/a/lib.dylib": parsed(slice({ platform: null })),
        "Contents/MacOS/b/lib.dylib": parsed(slice()),
      }),
      { roots: [MAIN] },
    );
    const edge = edgeFor(trace, MAIN, "@rpath/lib.dylib");
    expect(edge.candidates.map(({ outcome }) => outcome)).toEqual([
      "undetermined",
      "resolved",
    ]);
    expect(edge.resolution.status).toBe("conditional");
  });

  it("applies dyld Catalyst and zippered platform compatibility", async () => {
    const catalystProcess = await traceDylibLoading(
      memoryView({
        [MAIN]: executable({
          platform: 6,
          platforms: [6],
          rpaths: ["@executable_path/catalyst"],
          dependencies: [dependency("@rpath/lib.dylib")],
        }),
        "Contents/MacOS/catalyst/lib.dylib": parsed(
          slice({ platform: 1, platforms: [1] }),
        ),
      }),
      { roots: [MAIN] },
    );
    expect(
      edgeFor(catalystProcess, MAIN, "@rpath/lib.dylib").resolution,
    ).toEqual({
      status: "resolved",
      image: "Contents/MacOS/catalyst/lib.dylib",
    });

    const zipperedImage = await traceDylibLoading(
      memoryView({
        [MAIN]: executable({
          platform: 1,
          platforms: [1],
          rpaths: ["@executable_path/zippered"],
          dependencies: [dependency("@rpath/lib.dylib")],
        }),
        "Contents/MacOS/zippered/lib.dylib": parsed(
          slice({ platform: null, platforms: [1, 6] }),
        ),
      }),
      { roots: [MAIN] },
    );
    expect(
      edgeFor(zipperedImage, MAIN, "@rpath/lib.dylib").resolution,
    ).toMatchObject({
      status: "resolved",
      image: "Contents/MacOS/zippered/lib.dylib",
    });
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
    });
    expect(trace.images.find(({ path }) => path === broken)?.reason).toBe(
      "load command 0 has invalid cmdsize 0",
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

it("propagates embedded search-path uncertainty through found, missing, lazy and descendant edges", async () => {
  const child = "Contents/MacOS/child.dylib";
  const trace = await traceDylibLoading(
    memoryView({
      [MAIN]: executable({
        dyld_environment: ["DYLD_LIBRARY_PATH=/tmp"],
        dependencies: [
          dependency("@executable_path/child.dylib"),
          dependency("@executable_path/missing.dylib"),
          dependency("@executable_path/lazy.dylib", {
            command: "LC_LAZY_LOAD_DYLIB",
          }),
        ],
      }),
      [child]: parsed(
        slice({ dependencies: [dependency("@loader_path/gone.dylib")] }),
      ),
    }),
    { roots: [MAIN] },
  );
  expect(trace.edges.map(({ resolution }) => resolution.status)).toEqual([
    "conditional",
    "undetermined",
    "undetermined",
    "undetermined",
  ]);
  expect(trace.edges.at(-1)?.loader_conditional).toBe(true);
  expect(trace.findings.map(({ kind }) => kind)).toEqual([
    "dyld-environment-present",
  ]);
});

it.each([
  "DYLD_PRINT_LIBRARIES=1",
  "DYLD_PRINT_RPATHS=1",
  "DYLD_LIBRARY_PATH_LOG=/tmp",
  "DYLD_LIBRARY_PATH",
  "DYLD_IMAGE_SUFFIX=",
  "DYLD_INSERT_LIBRARIES=",
])(
  "retains %s as an observation without adding path uncertainty",
  async (setting) => {
    const child = "Contents/MacOS/child.dylib";
    const trace = await traceDylibLoading(
      memoryView({
        [MAIN]: executable({
          dyld_environment: [setting],
          dependencies: [dependency("@executable_path/child.dylib")],
        }),
        [child]: parsed(slice()),
      }),
      { roots: [MAIN] },
    );
    expect(trace.edges[0]?.resolution.status).toBe("resolved");
    expect(trace.coverage.status).toBe("complete");
    expect(
      trace.images.find(({ path }) => path === MAIN)?.slices[0]
        ?.dyld_environment,
    ).toEqual([setting]);
    expect(trace.findings.map(({ kind }) => kind)).toContain(
      "dyld-environment-present",
    );
  },
);

it.each(["execute", "bundle", "other"] as const)(
  "does not resolve a %s image as a dylib dependency",
  async (file_type) => {
    const child = "Contents/MacOS/child.dylib";
    const trace = await traceDylibLoading(
      memoryView({
        [MAIN]: executable({
          dependencies: [dependency("@executable_path/child.dylib")],
        }),
        [child]: parsed(slice({ file_type })),
      }),
      { roots: [MAIN] },
    );
    expect(trace.edges[0]).toMatchObject({
      candidates: [{ outcome: "not-loadable" }],
      resolution: { status: "unresolved", image: null },
    });
    expect(trace.edges).toHaveLength(1);
  },
);

it.each([
  "@loader_path/child.dylib",
  "@executable_path/child.dylib",
  "@rpath/child.dylib",
])(
  "keeps a found %s definitive under library fallback paths",
  async (install_name) => {
    const child = "Contents/MacOS/child.dylib";
    const trace = await traceDylibLoading(
      memoryView({
        [MAIN]: executable({
          dyld_environment: ["DYLD_FALLBACK_LIBRARY_PATH=/fallback"],
          rpaths: ["@executable_path"],
          dependencies: [dependency(install_name)],
        }),
        [child]: parsed(
          slice({
            dependencies: [dependency("@loader_path/grandchild.dylib")],
          }),
        ),
        "Contents/MacOS/grandchild.dylib": parsed(slice()),
      }),
      { roots: [MAIN] },
    );
    expect(trace.edges.map(({ resolution }) => resolution.status)).toEqual([
      "resolved",
      "resolved",
    ]);
    expect(
      trace.edges.every(({ loader_conditional }) => !loader_conditional),
    ).toBe(true);
    expect(trace.coverage.status).toBe("complete");
  },
);

it.each([
  [
    "DYLD_FRAMEWORK_PATH=/override",
    "@loader_path/child.dylib",
    "resolved",
    "complete",
  ],
  [
    "DYLD_FRAMEWORK_PATH=/override",
    "@loader_path/Foo.framework/Libraries/child.dylib",
    "resolved",
    "complete",
  ],
  [
    "DYLD_FRAMEWORK_PATH=/override",
    "@loader_path/Foo.framework/Bar",
    "resolved",
    "complete",
  ],
  [
    "DYLD_FRAMEWORK_PATH=/override",
    "@loader_path/Foo.framework/Foo",
    "conditional",
    "partial",
  ],
  [
    "DYLD_FRAMEWORK_PATH=/override",
    "@loader_path/Foo.framework/Versions/A/Foo",
    "conditional",
    "partial",
  ],
  [
    "DYLD_LIBRARY_PATH=/override",
    "@loader_path/Foo.framework/Foo",
    "resolved",
    "complete",
  ],
  [
    "DYLD_LIBRARY_PATH=/override",
    "@loader_path/Foo.framework/Libraries/child.dylib",
    "conditional",
    "partial",
  ],
  [
    "DYLD_FALLBACK_FRAMEWORK_PATH=/fallback",
    "@loader_path/Foo.framework/Foo",
    "resolved",
    "complete",
  ],
  [
    "DYLD_FALLBACK_FRAMEWORK_PATH=/fallback",
    "@loader_path/child.dylib",
    "resolved",
    "complete",
  ],
] as const)(
  "scopes %s to the image kind and reached search phase of %s",
  async (setting, install_name, status, coverage) => {
    const child = install_name.replace("@loader_path", "Contents/MacOS");
    const trace = await traceDylibLoading(
      memoryView({
        [MAIN]: executable({
          dyld_environment: [setting],
          dependencies: [dependency(install_name)],
        }),
        [child]: parsed(slice()),
      }),
      { roots: [MAIN] },
    );
    expect(trace.edges[0]?.resolution).toEqual({ status, image: child });
    expect(trace.coverage.status).toBe(coverage);
  },
);

it.each([
  [
    "DYLD_FALLBACK_LIBRARY_PATH=/fallback",
    "@loader_path/missing.dylib",
    "undetermined",
    "partial",
  ],
  [
    "DYLD_FALLBACK_FRAMEWORK_PATH=/fallback",
    "@loader_path/Foo.framework/Foo",
    "undetermined",
    "partial",
  ],
  [
    "DYLD_FALLBACK_FRAMEWORK_PATH=/fallback",
    "@loader_path/missing.dylib",
    "unresolved",
    "complete",
  ],
  [
    "DYLD_FALLBACK_LIBRARY_PATH=/fallback",
    "@loader_path/Foo.framework/Foo",
    "unresolved",
    "complete",
  ],
] as const)(
  "retains the applicable fallback uncertainty for %s and %s",
  async (setting, install_name, status, coverage) => {
    const trace = await traceDylibLoading(
      memoryView({
        [MAIN]: executable({
          dyld_environment: [setting],
          dependencies: [dependency(install_name)],
        }),
      }),
      { roots: [MAIN] },
    );
    expect(trace.edges[0]?.resolution).toEqual({ status, image: null });
    expect(trace.coverage.status).toBe(coverage);
  },
);

it.each([
  ["DYLD_ROOT_PATH=/root", [1], "@loader_path/child.dylib"],
  ["DYLD_ROOT_PATH=/root", [7], "@loader_path/child.dylib"],
  ["DYLD_ROOT_PATH=/root", [8], "@executable_path/child.dylib"],
  ["DYLD_ROOT_PATH=/root", [9], "@rpath/child.dylib"],
  ["DYLD_ROOT_PATH=/root", [12], "@rpath/child.dylib"],
  ["DYLD_OVERLAY_PATH=/overlay", [1], "@rpath/child.dylib"],
  ["DYLD_OVERLAY_PATH=/overlay", [7], "@loader_path/child.dylib"],
  ["DYLD_ROOT_PATH=", [7], "@loader_path/child.dylib"],
  ["DYLD_OVERLAY_PATH=", [1], "@loader_path/child.dylib"],
] as const)(
  "limits prefix setting %s on platforms %j for %s",
  async (setting, platforms, install_name) => {
    const child = "Contents/MacOS/child.dylib";
    const trace = await traceDylibLoading(
      memoryView({
        [MAIN]: executable({
          platforms: [...platforms],
          dyld_environment: [setting],
          rpaths: ["@executable_path"],
          dependencies: [dependency(install_name)],
        }),
        [child]: parsed(slice({ platforms: [...platforms] })),
      }),
      { roots: [MAIN] },
    );
    expect(trace.edges[0]?.resolution.status).toBe("resolved");
    expect(trace.coverage.status).toBe("complete");
    expect(
      trace.images.find(({ path }) => path === MAIN)?.slices[0]
        ?.dyld_environment,
    ).toEqual([setting]);
  },
);

it.each([
  ["DYLD_ROOT_PATH=/root", [1], "complete"],
  ["DYLD_ROOT_PATH=/root", [2], "complete"],
  ["DYLD_ROOT_PATH=/root", [6], "complete"],
  ["DYLD_ROOT_PATH=/root", [7], "partial"],
  ["DYLD_ROOT_PATH=/root", [8], "partial"],
  ["DYLD_ROOT_PATH=/root", [9], "partial"],
  ["DYLD_ROOT_PATH=/root", [12], "partial"],
  ["DYLD_ROOT_PATH=/root", [], "partial"],
  ["DYLD_ROOT_PATH=/root", [99], "partial"],
  ["DYLD_OVERLAY_PATH=/overlay", [1], "partial"],
] as const)(
  "retains only possible absolute-path prefix uncertainty for %s on %j",
  async (setting, platforms, coverage) => {
    const trace = await traceDylibLoading(
      memoryView({
        [MAIN]: executable({
          platforms: [...platforms],
          dyld_environment: [setting],
          dependencies: [dependency("/usr/lib/child.dylib")],
        }),
      }),
      { roots: [MAIN] },
    );
    expect(trace.edges[0]?.resolution.status).toBe("undetermined");
    expect(trace.coverage.status).toBe(coverage);
  },
);

it.each(["dylib", "bundle", "other"] as const)(
  "ignores embedded process settings from a %s root while retaining load findings",
  async (file_type) => {
    const root = "Contents/MacOS/root";
    const child = "Contents/MacOS/child.dylib";
    const settings = [
      "DYLD_LIBRARY_PATH=/external",
      "DYLD_INSERT_LIBRARIES=/external/injected.dylib",
    ];
    const trace = await traceDylibLoading(
      memoryView({
        [root]: parsed(
          slice({
            file_type,
            dyld_environment: settings,
            dependencies: [
              dependency("@loader_path/child.dylib"),
              dependency("@loader_path/missing.dylib"),
              dependency("@loader_path/lazy.dylib", {
                command: "LC_LAZY_LOAD_DYLIB",
              }),
            ],
          }),
        ),
        [child]: parsed(
          slice({
            dependencies: [dependency("@loader_path/descendant.dylib")],
          }),
        ),
      }),
      { roots: [root] },
    );
    expect(trace.edges.map(({ resolution }) => resolution.status)).toEqual([
      "resolved",
      "unresolved",
      "unresolved",
      "unresolved",
    ]);
    expect(
      trace.edges.every(({ loader_conditional }) => !loader_conditional),
    ).toBe(true);
    expect(trace.coverage.status).toBe("complete");
    expect(
      trace.findings.filter(({ kind }) => kind === "required-load-unresolved"),
    ).toHaveLength(2);
    expect(
      trace.findings.find(({ kind }) => kind === "required-load-unresolved")
        ?.explanation,
    ).toContain("load this required dependency");
    expect(
      trace.findings.filter(({ kind }) => kind === "lazy-load-unresolved"),
    ).toHaveLength(1);
    expect(
      trace.images.find(({ path }) => path === root)?.slices[0]
        ?.dyld_environment,
    ).toEqual(settings);
    expect(
      trace.findings.find(({ kind }) => kind === "dyld-environment-present")
        ?.explanation,
    ).toContain("entries in this non-executable root are observations");
  },
);

it("keeps inserted-library uncertainty scoped to the executable's process", async () => {
  const library = "Contents/MacOS/library.dylib";
  const trace = await traceDylibLoading(
    memoryView({
      [MAIN]: executable({
        dyld_environment: ["DYLD_INSERT_LIBRARIES=/external/injected.dylib"],
      }),
      [library]: parsed(
        slice({
          dyld_environment: ["DYLD_INSERT_LIBRARIES=/external/ignored.dylib"],
        }),
      ),
    }),
    { roots: [library, MAIN] },
  );
  expect(trace.coverage.status).toBe("partial");
  const limitation = trace.limitations.find((value) =>
    value.includes("LC_DYLD_ENVIRONMENT"),
  );
  expect(limitation).toContain(MAIN);
  expect(limitation).not.toContain(library);
});

it.each([
  [
    "DYLD_LIBRARY_PATH=",
    "@loader_path/child.dylib",
    "conditional",
    "undetermined",
  ],
  [
    "DYLD_LIBRARY_PATH=: ",
    "@loader_path/child.dylib",
    "conditional",
    "undetermined",
  ],
  [
    "DYLD_FRAMEWORK_PATH=",
    "@loader_path/Foo.framework/Foo",
    "conditional",
    "undetermined",
  ],
  [
    "DYLD_FALLBACK_LIBRARY_PATH=",
    "@loader_path/child.dylib",
    "resolved",
    "undetermined",
  ],
  [
    "DYLD_FALLBACK_LIBRARY_PATH=:",
    "@loader_path/child.dylib",
    "resolved",
    "undetermined",
  ],
  [
    "DYLD_FALLBACK_FRAMEWORK_PATH=",
    "@loader_path/Foo.framework/Foo",
    "resolved",
    "undetermined",
  ],
  [
    "DYLD_VERSIONED_LIBRARY_PATH=",
    "@loader_path/child.dylib",
    "resolved",
    "unresolved",
  ],
  [
    "DYLD_VERSIONED_LIBRARY_PATH=:",
    "@loader_path/child.dylib",
    "resolved",
    "unresolved",
  ],
  [
    "DYLD_VERSIONED_FRAMEWORK_PATH=",
    "@loader_path/Foo.framework/Foo",
    "resolved",
    "unresolved",
  ],
  [
    "DYLD_VERSIONED_FRAMEWORK_PATH=::",
    "@loader_path/Foo.framework/Foo",
    "resolved",
    "unresolved",
  ],
  [
    "DYLD_VERSIONED_LIBRARY_PATH= ",
    "@loader_path/child.dylib",
    "conditional",
    "undetermined",
  ],
  ["DYLD_IMAGE_SUFFIX=:", "@loader_path/child.dylib", "resolved", "unresolved"],
  [
    "DYLD_IMAGE_SUFFIX=::",
    "@loader_path/Foo.framework/Foo",
    "resolved",
    "unresolved",
  ],
  [
    "DYLD_IMAGE_SUFFIX=:_debug:",
    "@loader_path/child.dylib",
    "conditional",
    "undetermined",
  ],
  [
    "DYLD_INSERT_LIBRARIES=",
    "@loader_path/child.dylib",
    "resolved",
    "unresolved",
  ],
  [
    "DYLD_INSERT_LIBRARIES=:",
    "@loader_path/child.dylib",
    "conditional",
    "undetermined",
  ],
] as const)(
  "interprets the empty components of %s according to their consumer for %s",
  async (setting, installName, foundStatus, missingStatus) => {
    const child = installName.replace("@loader_path", "Contents/MacOS");
    for (const [exists, status] of [
      [true, foundStatus],
      [false, missingStatus],
    ] as const) {
      const trace = await traceDylibLoading(
        memoryView({
          [MAIN]: executable({
            dyld_environment: [setting],
            dependencies: [dependency(installName)],
          }),
          ...(exists ? { [child]: parsed(slice()) } : {}),
        }),
        { roots: [MAIN] },
      );
      expect(trace.edges[0]?.resolution.status).toBe(status);
      expect(trace.coverage.status).toBe(
        status === "conditional" || status === "undetermined"
          ? "partial"
          : "complete",
      );
      expect(
        trace.images.find(({ path }) => path === MAIN)?.slices[0]
          ?.dyld_environment,
      ).toEqual([setting]);
      expect(
        trace.findings.some(({ kind }) => kind === "required-load-unresolved"),
      ).toBe(status === "unresolved");
    }
  },
);
