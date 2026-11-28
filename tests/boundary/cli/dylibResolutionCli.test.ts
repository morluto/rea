import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect } from "vitest";

import {
  CPU,
  FILE_TYPE,
  LC,
  buildVersionCommand,
  dylibCommand,
  dyldEnvironmentCommand,
  fatImage,
  machoImage,
  rpathCommand,
  versionMinCommand,
} from "../../../src/artifacts/apple/MachoImage.fixture.js";
import { dylibResolutionResultSchema } from "../../../src/domain/apple/dylibResolution.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

const ENVIRONMENT = { REA_LOG_LEVEL: "silent", REA_ANALYSIS_PROVIDER: "auto" };

const writeFiles = async (
  root: string,
  files: Readonly<Record<string, string | Uint8Array>>,
): Promise<void> => {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
};

/** A caller-selected root that cannot be traced is an input issue on that root. */
const expectRootInputError = async (
  cli: TestCli,
  {
    app,
    root,
    reason,
    message,
  }: {
    readonly app: string;
    readonly root: string;
    readonly reason: string;
    readonly message: string;
  },
): Promise<void> => {
  const rejected = await cli.run({
    arguments: ["trace-dylib-resolution", app, "--root", root, "--json"],
    environment: ENVIRONMENT,
  });
  expect(rejected.exitCode).toBe(1);
  // The contract's root syntax is checked at argv parsing; facts about the
  // selected file are checked by the analysis. Both name the CLI option.
  if (reason === "invalid_format") {
    expect(rejected.json).toMatchObject({
      code: "VALIDATION_ERROR",
      fieldErrors: [
        { path: "root.0", message: expect.stringContaining(message) },
      ],
    });
    return;
  }
  expect(rejected.json).toMatchObject({
    error: "Analysis failed",
    code: "invalid_request",
    details: {
      issues: [
        {
          path: ["root", 0],
          reason,
          message: expect.stringContaining(message),
        },
      ],
    },
  });
};

/** The CLI option shares the contract's root format, so it refuses an escaping root itself and names the option. */
const expectEscapingRootRefusedByCli = async (
  cli: TestCli,
  app: string,
): Promise<void> => {
  const escaping = await cli.run({
    arguments: [
      "trace-dylib-resolution",
      app,
      "--root",
      "../outside",
      "--json",
    ],
    environment: ENVIRONMENT,
  });
  expect(escaping.exitCode).toBe(1);
  expect(escaping.json).toMatchObject({
    code: "VALIDATION_ERROR",
    fieldErrors: [
      expect.objectContaining({
        path: expect.stringMatching(/^root/u),
        message: expect.stringContaining("Use a normalized path"),
      }),
    ],
  });
};

const fixtureApp = async (): Promise<string> => {
  const app = join(
    await createTestTempDirectory("rea-dylib-cli-"),
    "Fixture.app",
  );
  await writeFiles(app, {
    "Contents/Info.plist":
      "<plist><dict><key>CFBundleExecutable</key><string>App</string></dict></plist>",
    "Contents/MacOS/App": machoImage({
      commands: [
        buildVersionCommand(1),
        rpathCommand("@executable_path/../Frameworks"),
        dylibCommand(LC.LOAD_DYLIB, "@rpath/libcore.dylib"),
        dylibCommand(LC.LOAD_WEAK_DYLIB, "@rpath/libgone.dylib"),
      ],
    }),
    "Contents/Frameworks/libcore.dylib": machoImage({
      fileType: FILE_TYPE.dylib,
      commands: [
        buildVersionCommand(1),
        dylibCommand(LC.ID_DYLIB, "@rpath/libcore.dylib"),
      ],
    }),
    "Contents/Helpers/tool": machoImage({
      commands: [
        buildVersionCommand(1),
        dylibCommand(LC.LOAD_DYLIB, "@loader_path/libnone.dylib"),
      ],
    }),
  });
  return app;
};

const withBrokenHelper = async (app: string): Promise<void> => {
  const broken = machoImage({ commands: [rpathCommand("x")] });
  // cmdsize 0 makes the command table unreadable.
  new DataView(broken.buffer).setUint32(32 + 4, 0, true);
  await writeFiles(app, { "Contents/Helpers/broken": broken });
};

cliTest.skipIf(process.platform !== "linux")(
  "keeps unrepresentable bundle entries from establishing complete executable-root coverage",
  async ({ cli }) => {
    const app = await fixtureApp();
    await writeFile(
      Buffer.concat([
        Buffer.from(`${app}/Contents/Helpers/`),
        Buffer.from([0xff]),
      ]),
      machoImage({}),
    );
    const observed = await cli.run({
      arguments: ["trace-dylib-resolution", app, "--json"],
      environment: ENVIRONMENT,
    });
    expect(observed.exitCode, observed.stderr).toBe(0);
    const result = dylibResolutionResultSchema.parse(
      parseEvidence(observed.json).normalized_result,
    );
    expect(result.coverage.status).toBe("partial");
    expect(result.limitations).toContainEqual(
      expect.stringContaining("not valid UTF-8"),
    );
  },
);

cliTest(
  "reports skipped executable-root symlink subtrees as partial discovery",
  async ({ cli }) => {
    const app = await fixtureApp();
    await symlink("unexamined", join(app, "Contents", "LinkedResources"));
    const observed = await cli.run({
      arguments: ["trace-dylib-resolution", app, "--json"],
      environment: ENVIRONMENT,
    });
    expect(observed.exitCode, observed.stderr).toBe(0);
    const result = dylibResolutionResultSchema.parse(
      parseEvidence(observed.json).normalized_result,
    );
    expect(result.coverage.status).toBe("partial");
    expect(result.limitations).toContainEqual(
      expect.stringContaining(
        "their root roles and possible descendants are unknown",
      ),
    );
  },
);

cliTest(
  "does not turn U+FEFF-prefixed strings into dyld path tokens",
  async ({ cli }) => {
    const app = await fixtureApp();
    await writeFiles(app, {
      "Contents/MacOS/App": machoImage({
        commands: [
          buildVersionCommand(1),
          rpathCommand("@executable_path/../Frameworks"),
          dylibCommand(LC.LOAD_DYLIB, "@rpath/libcore.dylib"),
          dylibCommand(LC.LOAD_DYLIB, "\uFEFF@rpath/libcore.dylib"),
        ],
      }),
      "Contents/Helpers/tool": machoImage({
        commands: [
          buildVersionCommand(1),
          rpathCommand("\uFEFF@loader_path/../Frameworks"),
          dylibCommand(LC.LOAD_DYLIB, "@rpath/libcore.dylib"),
        ],
      }),
    });
    const output = await cli.run({
      arguments: ["trace-dylib-resolution", app, "--json"],
      environment: ENVIRONMENT,
    });
    expect(output.exitCode, output.stderr).toBe(0);
    const trace = dylibResolutionResultSchema.parse(
      parseEvidence(output.json).normalized_result,
    );
    const ordinary = trace.edges.find(
      ({ loader, install_name }) =>
        loader === "Contents/MacOS/App" &&
        install_name === "@rpath/libcore.dylib",
    );
    expect(ordinary?.resolution).toMatchObject({
      status: "resolved",
      image: "Contents/Frameworks/libcore.dylib",
    });
    const marked = trace.edges.find(
      ({ install_name }) => install_name === "\uFEFF@rpath/libcore.dylib",
    );
    expect(marked).toBeDefined();
    expect(marked?.resolution.image).toBeNull();
    const helper = trace.edges.find(
      ({ loader }) => loader === "Contents/Helpers/tool",
    );
    expect(helper).toBeDefined();
    expect(helper?.resolution.image).toBeNull();
  },
);

cliTest(
  "resolves dependency names and rpaths containing Unicode line separators",
  async ({ cli }) => {
    const app = await fixtureApp();
    const library = "lib\u2028core.dylib";
    const directory = "Libraries\u2029Nested";
    await writeFiles(app, {
      "Contents/MacOS/App": machoImage({
        commands: [
          buildVersionCommand(1),
          dylibCommand(LC.LOAD_DYLIB, `@loader_path/${library}`),
          rpathCommand(`@executable_path/${directory}`),
          dylibCommand(LC.LOAD_DYLIB, "@rpath/libsearch.dylib"),
        ],
      }),
      [`Contents/MacOS/${library}`]: machoImage({
        fileType: FILE_TYPE.dylib,
        commands: [buildVersionCommand(1)],
      }),
      [`Contents/MacOS/${directory}/libsearch.dylib`]: machoImage({
        fileType: FILE_TYPE.dylib,
        commands: [buildVersionCommand(1)],
      }),
    });
    const output = await cli.run({
      arguments: [
        "trace-dylib-resolution",
        app,
        "--root",
        "Contents/MacOS/App",
        "--json",
      ],
      environment: ENVIRONMENT,
    });
    expect(output.exitCode, output.stderr).toBe(0);
    const trace = dylibResolutionResultSchema.parse(
      parseEvidence(output.json).normalized_result,
    );
    expect(
      trace.edges.map(({ install_name, resolution }) => ({
        install_name,
        resolution,
      })),
    ).toEqual([
      {
        install_name: `@loader_path/${library}`,
        resolution: {
          status: "resolved",
          image: `Contents/MacOS/${library}`,
        },
      },
      {
        install_name: "@rpath/libsearch.dylib",
        resolution: {
          status: "resolved",
          image: `Contents/MacOS/${directory}/libsearch.dylib`,
        },
      },
    ]);
  },
);

const loadedSiblingFixture = async (
  dependency: "eager" | "lazy" | "none" | "conditional",
) => {
  const uncertain = dependency === "conditional";
  const nested = dependency === "eager" || uncertain;
  const app = await createTestTempDirectory("rea-dyld-sibling-chain-");
  const root = "App";
  await writeFiles(app, {
    [root]: machoImage({
      commands: [
        buildVersionCommand(1),
        rpathCommand("@executable_path/fallback"),
        dylibCommand(LC.LOAD_DYLIB, "@loader_path/A.dylib"),
        dylibCommand(LC.LOAD_DYLIB, "@loader_path/B.dylib"),
      ],
    }),
    "A.dylib": machoImage({
      fileType: FILE_TYPE.dylib,
      commands: [
        buildVersionCommand(1),
        ...(uncertain
          ? [rpathCommand("@loader_path/search"), rpathCommand("@loader_path")]
          : []),
        rpathCommand("@loader_path/private"),
        ...(dependency === "none"
          ? []
          : [
              dylibCommand(
                nested ? LC.LOAD_DYLIB : LC.LAZY_LOAD_DYLIB,
                uncertain ? "@rpath/B.dylib" : "@loader_path/B.dylib",
              ),
            ]),
        dylibCommand(LC.LOAD_DYLIB, "@loader_path/C.dylib"),
      ],
    }),
    "B.dylib": machoImage({
      fileType: FILE_TYPE.dylib,
      commands: [
        buildVersionCommand(1),
        ...(uncertain
          ? [dylibCommand(LC.ID_DYLIB, "@rpath/cached-B.dylib")]
          : []),
        dylibCommand(LC.LOAD_DYLIB, "@rpath/leaf.dylib"),
        // The cycle must not expand B's dependencies a second time.
        dylibCommand(LC.LOAD_DYLIB, "@loader_path/A.dylib"),
        ...(uncertain
          ? [
              dylibCommand(LC.LOAD_DYLIB, "@rpath/missing.dylib"),
              dylibCommand(LC.LOAD_DYLIB, "@rpath/fallback-leaf.dylib"),
            ]
          : []),
      ],
    }),
    "private/leaf.dylib": machoImage({
      fileType: FILE_TYPE.dylib,
      commands: [buildVersionCommand(1)],
    }),
    "fallback/leaf.dylib": machoImage({
      fileType: FILE_TYPE.dylib,
      commands: [buildVersionCommand(1)],
    }),
    "C.dylib": machoImage({
      fileType: FILE_TYPE.dylib,
      commands: [
        buildVersionCommand(1),
        dylibCommand(LC.LOAD_DYLIB, "@loader_path/fallback/other.dylib"),
        ...(uncertain
          ? [dylibCommand(LC.LOAD_DYLIB, "@rpath/cached-B.dylib")]
          : []),
      ],
    }),
    "fallback/other.dylib": machoImage({
      fileType: FILE_TYPE.dylib,
      commands: [buildVersionCommand(1)],
    }),
  });
  if (uncertain) {
    await writeFiles(app, {
      // Unknown platform compatibility prevents ruling this candidate out.
      "search/B.dylib": machoImage({
        fileType: FILE_TYPE.dylib,
        commands: [buildVersionCommand(999)],
      }),
      "fallback/fallback-leaf.dylib": machoImage({
        fileType: FILE_TYPE.dylib,
        commands: [buildVersionCommand(1)],
      }),
      "search/leaf.dylib": machoImage({
        fileType: FILE_TYPE.dylib,
        commands: [buildVersionCommand(1)],
      }),
    });
  }
  return { app, root, nested, uncertain };
};

for (const dependency of ["eager", "lazy", "none", "conditional"] as const) {
  cliTest(
    `uses the first expansion chain for a loaded sibling (${dependency} nested dependency)`,
    async ({ cli }) => {
      const { app, root, nested, uncertain } =
        await loadedSiblingFixture(dependency);
      const output = await cli.run({
        arguments: ["trace-dylib-resolution", join(app, root), "--json"],
        environment: ENVIRONMENT,
      });
      expect(output.exitCode, JSON.stringify(output.json)).toBe(0);
      const trace = dylibResolutionResultSchema.parse(
        parseEvidence(output.json).normalized_result,
      );
      expect(trace.edges.map(({ loader }) => loader)).toEqual([
        root,
        root,
        ...(dependency === "none" ? [] : ["A.dylib"]),
        "A.dylib",
        ...(nested
          ? [
              "B.dylib",
              "B.dylib",
              ...(uncertain ? ["B.dylib", "B.dylib"] : []),
              "C.dylib",
            ]
          : ["C.dylib", "B.dylib", "B.dylib"]),
        ...(uncertain ? ["C.dylib"] : []),
      ]);
      const leaf = trace.edges.find(
        (edge) => edge.install_name === "@rpath/leaf.dylib",
      );
      expect(leaf).toMatchObject({
        loader: "B.dylib",
        loader_conditional: uncertain,
        via: nested ? [root, "A.dylib", "B.dylib"] : [root, "B.dylib"],
        resolution: {
          status: "resolved",
          image: uncertain
            ? "search/leaf.dylib"
            : nested
              ? "private/leaf.dylib"
              : "fallback/leaf.dylib",
        },
        candidates: [
          expect.objectContaining({
            rpath_owner: nested ? "A.dylib" : root,
          }),
        ],
      });
      if (uncertain) {
        expect(
          trace.edges.find(
            (edge) =>
              edge.loader === "A.dylib" &&
              edge.install_name === "@rpath/B.dylib",
          ),
        ).toMatchObject({
          resolution: { status: "conditional", image: "B.dylib" },
          candidates: [
            expect.objectContaining({ outcome: "undetermined" }),
            expect.objectContaining({ outcome: "resolved" }),
          ],
        });
        expect(trace.edges[1]).toMatchObject({
          loader: root,
          loader_conditional: false,
          resolution: { status: "resolved", image: "B.dylib" },
        });
        for (const [name, kind] of [
          ["@rpath/missing.dylib", "required-load-unresolved"],
          ["@rpath/fallback-leaf.dylib", "earlier-rpath-candidate-absent"],
        ]) {
          const finding = trace.findings.find(
            (item) =>
              item.kind === kind &&
              trace.edges[item.edge_index ?? -1]?.install_name === name,
          );
          expect(finding?.explanation).toContain("dependency-expansion chain");
          expect(finding?.explanation).not.toContain(
            "loads only conditionally",
          );
        }
        // B itself was loaded definitively by App. Its uncertain expansion
        // chain must not contaminate later install-name reuse from C.
        expect(trace.edges.at(-1)).toMatchObject({
          loader: "C.dylib",
          loader_conditional: false,
          resolution: { status: "resolved", image: "B.dylib" },
          candidates: [expect.objectContaining({ source: "already-loaded" })],
        });
      }
    },
  );
}

describe("trace-dylib-resolution CLI", () => {
  cliTest("traces every executable root of an app bundle", async ({ cli }) => {
    const app = await fixtureApp();
    const result = await cli.run({
      arguments: ["trace-dylib-resolution", app, "--json"],
      environment: ENVIRONMENT,
    });
    expect(result.exitCode, JSON.stringify(result.json)).toBe(0);
    const trace = dylibResolutionResultSchema.parse(
      (result.json as { normalized_result: unknown }).normalized_result,
    );
    expect(trace.root_path).toBe(app);
    expect(trace.roots.map(({ image }) => image)).toEqual([
      "Contents/Helpers/tool",
      "Contents/MacOS/App",
    ]);
    // The normalized result is the provider's only representation; Evidence
    // must not carry it a second time as raw_result.
    expect(result.json).toMatchObject({ raw_result: null });
    expect(
      trace.edges.map(({ loader, install_name: name, resolution }) => [
        loader,
        name,
        resolution.status,
        resolution.image,
      ]),
    ).toEqual([
      [
        "Contents/Helpers/tool",
        "@loader_path/libnone.dylib",
        "unresolved",
        null,
      ],
      [
        "Contents/MacOS/App",
        "@rpath/libcore.dylib",
        "resolved",
        "Contents/Frameworks/libcore.dylib",
      ],
      ["Contents/MacOS/App", "@rpath/libgone.dylib", "unresolved", null],
    ]);
    expect(trace.findings.map(({ kind }) => kind)).toEqual([
      "required-load-unresolved",
      "weak-load-unresolved",
    ]);
    const imageDigests = await Promise.all(
      [
        "Contents/Frameworks/libcore.dylib",
        "Contents/Helpers/tool",
        "Contents/MacOS/App",
      ].map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(join(app, path)))
          .digest("hex"),
      ]),
    );
    expect(trace.images.map(({ path, sha256 }) => [path, sha256])).toEqual(
      imageDigests,
    );
  });

  cliTest(
    "narrows roots and architecture, and rejects escaping roots",
    async ({ cli }) => {
      const app = await fixtureApp();
      const narrowed = await cli.run({
        arguments: [
          "trace-dylib-resolution",
          app,
          "--root",
          "Contents/MacOS/App",
          "--architecture",
          "arm64",
          "--json",
        ],
        environment: ENVIRONMENT,
      });
      expect(narrowed.exitCode).toBe(0);
      expect(
        (narrowed.json as { normalized_result: { roots: unknown } })
          .normalized_result.roots,
      ).toEqual([{ image: "Contents/MacOS/App", architecture: "arm64" }]);
      // A root below a symlinked directory that points outside the bundle.
      const outside = await createTestTempDirectory("rea-dylib-outside-");
      await writeFiles(outside, { Tool: machoImage({}) });
      await symlink(outside, join(app, "Contents/Linked"), "dir");
      await expectEscapingRootRefusedByCli(cli, app);
      for (const [root, reason, message] of [
        ["Contents/Info.plist", "invalid_value", "is not a Mach-O image"],
        [
          "Contents/Linked/Tool",
          "invalid_value",
          // Windows link text is outside the POSIX dyld path representation.
          process.platform === "win32"
            ? "is not a regular file in the analyzed root"
            : "resolves outside the analyzed root",
        ],
      ] as const) {
        await expectRootInputError(cli, { app, root, reason, message });
      }
    },
  );

  cliTest(
    "resolves a standalone Mach-O against its own directory",
    async ({ cli }) => {
      const directory = await createTestTempDirectory("rea-dylib-standalone-");
      await writeFiles(directory, {
        tool: machoImage({
          commands: [
            buildVersionCommand(1),
            dylibCommand(LC.LOAD_DYLIB, "@loader_path/lib/libhelper.dylib"),
            dylibCommand(LC.LOAD_DYLIB, "@loader_path/../escape.dylib"),
          ],
        }),
        "lib/libhelper.dylib": machoImage({
          fileType: FILE_TYPE.dylib,
          commands: [buildVersionCommand(1)],
        }),
        "unrelated.txt": "not traversed",
      });
      const result = await cli.run({
        arguments: [
          "trace-dylib-resolution",
          join(directory, "tool"),
          "--json",
        ],
        environment: ENVIRONMENT,
      });
      expect(result.exitCode, JSON.stringify(result.json)).toBe(0);
      const trace = dylibResolutionResultSchema.parse(
        (result.json as { normalized_result: unknown }).normalized_result,
      );
      expect(trace.roots).toEqual([{ image: "tool", architecture: "arm64" }]);
      expect(trace.edges.map(({ resolution }) => resolution)).toEqual([
        { status: "resolved", image: "lib/libhelper.dylib" },
        { status: "undetermined", image: null },
      ]);
    },
  );
});

cliTest(
  "enforces build-version tool counts for underdeclared and truncated load commands",
  async ({ cli }) => {
    const app = await fixtureApp();
    const withTool = new Uint8Array(32);
    withTool.set(buildVersionCommand(0xffffffff));
    const toolView = new DataView(withTool.buffer);
    toolView.setUint32(4, 32, true);
    toolView.setUint32(20, 1, true);
    toolView.setUint32(24, 3, true);
    toolView.setUint32(28, 0x10000, true);

    const missingTool = buildVersionCommand(1);
    new DataView(missingTool.buffer).setUint32(20, 1, true);
    const excessiveTools = buildVersionCommand(1);
    new DataView(excessiveTools.buffer).setUint32(20, 0xffffffff, true);
    const missingSecondTool = withTool.slice();
    new DataView(missingSecondTool.buffer).setUint32(20, 2, true);
    const underdeclaredTool = withTool.slice();
    new DataView(underdeclaredTool.buffer).setUint32(20, 0, true);
    const shortHeader = buildVersionCommand(1).slice(0, 16);
    new DataView(shortHeader.buffer).setUint32(4, 16, true);
    const cases = [
      ["no-tools", [buildVersionCommand(1)], "parsed"],
      ["one-tool", [withTool], "parsed"],
      // The following command and the image's trailing bytes cannot satisfy ntools.
      ["missing-tool", [missingTool, rpathCommand("x")], "malformed"],
      ["excessive-tools", [excessiveTools], "malformed"],
      ["missing-second-tool", [missingSecondTool], "malformed"],
      ["underdeclared-tool", [underdeclaredTool], "malformed"],
      ["short-header", [shortHeader], "malformed"],
    ] as const;
    for (const [name, commands] of cases) {
      await writeFiles(app, {
        [`Contents/Helpers/${name}`]: machoImage({ commands }),
      });
    }

    const malformedPath = join(app, "Contents/Helpers/underdeclared-tool");
    const originalBytes = await readFile(malformedPath);
    const originalSha = createHash("sha256")
      .update(originalBytes)
      .digest("hex");
    const result = await cli.run({
      arguments: ["trace-dylib-resolution", app, "--json"],
      environment: ENVIRONMENT,
    });
    expect(result.exitCode, JSON.stringify(result.json)).toBe(0);
    const trace = dylibResolutionResultSchema.parse(
      (result.json as { normalized_result: unknown }).normalized_result,
    );
    expect(
      trace.images.find(
        (image) => image.path === "Contents/Helpers/underdeclared-tool",
      ),
    ).toMatchObject({ sha256: originalSha });
    for (const [name, , status] of cases) {
      const path = `Contents/Helpers/${name}`;
      const image = trace.images.find((item) => item.path === path);
      expect(image, name).toMatchObject({ parse_status: status });
      if (status === "malformed") {
        expect(image).toMatchObject({
          reason: expect.stringContaining("LC_BUILD_VERSION"),
          slices: [],
        });
        expect(trace.roots.some((root) => root.image === path)).toBe(false);
        expect(trace.coverage.unparsed_images).toContain(path);
      } else {
        expect(image).toMatchObject({
          reason: null,
          slices: [{ platforms: [name === "one-tool" ? 0xffffffff : 1] }],
        });
      }
    }
    expect(trace.coverage.status).toBe("partial");

    const { call } = await connectLocalToolsMcp(ENVIRONMENT);
    const opened = await call("open_binary", { path: app });
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
    try {
      const response = await call("trace_dylib_resolution", {});
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      const mcpTrace = dylibResolutionResultSchema.parse(
        parseEvidence(response.structuredContent).normalized_result,
      );
      expect(mcpTrace).toEqual(trace);
      expect((await readFile(malformedPath)).equals(originalBytes)).toBe(true);
    } finally {
      const closed = await call("close_binary", {});
      expect(closed.isError, JSON.stringify(closed)).not.toBe(true);
    }
  },
);

cliTest(
  "rejects oversized legacy minimum-version commands before admitting platform",
  async ({ cli }) => {
    const app = await fixtureApp();
    const exact = versionMinCommand(LC.VERSION_MIN_IPHONEOS);
    const oversized = Buffer.concat([exact, Buffer.alloc(8)]);
    oversized.writeUInt32LE(oversized.length, 4);
    const validPath = "Contents/Helpers/minimum-version";
    const invalidPath = "Contents/Helpers/oversized-minimum-version";
    await writeFiles(app, {
      [validPath]: machoImage({ commands: [exact] }),
      [invalidPath]: machoImage({ commands: [oversized] }),
    });

    const result = await cli.run({
      arguments: ["trace-dylib-resolution", app, "--json"],
      environment: ENVIRONMENT,
    });
    expect(result.exitCode, JSON.stringify(result.json)).toBe(0);
    const trace = dylibResolutionResultSchema.parse(
      (result.json as { normalized_result: unknown }).normalized_result,
    );
    expect(trace.images.find(({ path }) => path === validPath)).toMatchObject({
      parse_status: "parsed",
      slices: [{ platforms: [2] }],
    });
    expect(trace.images.find(({ path }) => path === invalidPath)).toMatchObject(
      {
        parse_status: "malformed",
        reason: expect.stringContaining("version-min"),
        slices: [],
      },
    );
    expect(trace.coverage).toMatchObject({
      status: "partial",
      unparsed_images: expect.arrayContaining([invalidPath]),
    });
  },
);

cliTest(
  "retains directory requirements when resolving dylib install names",
  async ({ cli }) => {
    const directory = await createTestTempDirectory("rea-dylib-path-cli-");
    const names = [
      "@loader_path/lib/libhelper.dylib/",
      "@loader_path/lib/libhelper.dylib/.",
      "@rpath/libhelper.dylib/",
      "@rpath/libhelper.dylib/.",
      "@rpath/",
      "@loader_path/lib/./libhelper.dylib",
      "@loader_path/lib//libhelper.dylib",
    ];
    await writeFiles(directory, {
      tool: machoImage({
        commands: [
          buildVersionCommand(1),
          rpathCommand("@loader_path/lib/libhelper.dylib"),
          rpathCommand("@loader_path/lib"),
          ...names.map((name) => dylibCommand(LC.LOAD_DYLIB, name)),
        ],
      }),
      "lib/libhelper.dylib": machoImage({
        fileType: FILE_TYPE.dylib,
        commands: [buildVersionCommand(1)],
      }),
    });
    const result = await cli.run({
      arguments: ["trace-dylib-resolution", join(directory, "tool"), "--json"],
      environment: ENVIRONMENT,
    });
    expect(result.exitCode, JSON.stringify(result.json)).toBe(0);
    const trace = dylibResolutionResultSchema.parse(
      parseEvidence(result.json).normalized_result,
    );
    expect(
      trace.edges.map(({ install_name, candidates, resolution }) => ({
        install_name,
        outcome: candidates[0]?.outcome,
        resolution,
      })),
    ).toEqual(
      names.map((name, index) => ({
        install_name: name,
        outcome: index < 5 ? "absent" : "resolved",
        resolution:
          index < 5
            ? { status: "unresolved", image: null }
            : { status: "resolved", image: "lib/libhelper.dylib" },
      })),
    );
    expect(
      trace.findings.map(({ kind, edge_index }) => [kind, edge_index]),
    ).toEqual(
      [0, 1, 2, 3, 4].map((index) => ["required-load-unresolved", index]),
    );
  },
);

// This permission fixture requires POSIX mode bits and a non-root caller.
describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "trace-dylib-resolution permissions",
  () => {
    cliTest(
      "reports an unreadable dependency as a permission failure",
      async ({ cli }) => {
        const directory = await createTestTempDirectory("rea-dylib-denied-");
        await writeFiles(directory, {
          tool: machoImage({
            commands: [
              dylibCommand(LC.LOAD_DYLIB, "@loader_path/libsecret.dylib"),
            ],
          }),
          "libsecret.dylib": machoImage({ fileType: FILE_TYPE.dylib }),
        });
        await chmod(join(directory, "libsecret.dylib"), 0o000);
        try {
          const result = await cli.run({
            arguments: [
              "trace-dylib-resolution",
              join(directory, "tool"),
              "--json",
            ],
            environment: ENVIRONMENT,
          });
          expect(result.exitCode).toBe(1);
          expect(result.json).toMatchObject({
            details: {
              reason: "unavailable",
              detail: expect.stringContaining(
                "Permission denied (EACCES) reading libsecret.dylib",
              ),
            },
          });
        } finally {
          await chmod(join(directory, "libsecret.dylib"), 0o644);
        }
      },
    );
  },
);

cliTest(
  "explains why an earlier rpath candidate does not establish a definite choice under an embedded override",
  async ({ cli }) => {
    const setting = "DYLD_LIBRARY_PATH=/external";
    const app = await fixtureApp();
    await writeFiles(app, {
      "Contents/MacOS/App": machoImage({
        commands: [
          dyldEnvironmentCommand(setting),
          buildVersionCommand(1),
          rpathCommand("@executable_path/../Absent"),
          rpathCommand("@executable_path/../Frameworks"),
          dylibCommand(LC.LOAD_DYLIB, "@rpath/libcore.dylib"),
        ],
      }),
    });
    const result = await cli.run({
      arguments: [
        "trace-dylib-resolution",
        app,
        "--root",
        "Contents/MacOS/App",
        "--json",
      ],
      environment: ENVIRONMENT,
    });
    expect(result.exitCode, JSON.stringify(result.json)).toBe(0);
    const trace = dylibResolutionResultSchema.parse(
      parseEvidence(result.json).normalized_result,
    );
    expect(trace.edges[0]?.resolution).toEqual({
      status: "conditional",
      image: "Contents/Frameworks/libcore.dylib",
    });
    expect(
      trace.findings.find(
        ({ kind }) => kind === "earlier-rpath-candidate-absent",
      ),
    ).toMatchObject({
      image: "Contents/MacOS/App",
      explanation: expect.stringContaining(
        "does not establish which image dyld will load",
      ),
    });
  },
);

cliTest(
  "preserves exact architecture labels and each same-named slice's dyld environment",
  async ({ cli }) => {
    // Capability variants can share arm64e's display name, while .x1 stays exact.
    // A plain x86_64 slice keeps the bundle openable on x64 hosts.
    for (const [settings, expected] of [
      [[null, null, "DYLD_PRINT_RPATHS=1"], ["DYLD_PRINT_RPATHS=1"]],
      [
        [
          "DYLD_PRINT_LIBRARIES=1",
          "DYLD_PRINT_RPATHS=1",
          "DYLD_PRINT_BINDINGS=1",
        ],
        [
          "DYLD_PRINT_LIBRARIES=1",
          "DYLD_PRINT_RPATHS=1",
          "DYLD_PRINT_BINDINGS=1",
        ],
      ],
    ] as const) {
      const app = await fixtureApp();
      await writeFiles(app, {
        "Contents/MacOS/App": fatImage([
          ...[
            CPU.arm64e,
            CPU.arm64eX1,
            { type: CPU.arm64.type, subtype: 0x81000002 },
          ].map((cpu, index) => {
            const setting = settings[index];
            return {
              cpu,
              bytes: machoImage({
                cpu,
                commands:
                  setting === null || setting === undefined
                    ? []
                    : [dyldEnvironmentCommand(setting)],
              }),
            };
          }),
          { cpu: CPU.x86_64, bytes: machoImage({ cpu: CPU.x86_64 }) },
        ]),
      });
      const result = await cli.run({
        arguments: [
          "trace-dylib-resolution",
          app,
          "--root",
          "Contents/MacOS/App",
          "--architecture",
          "arm64e",
          "--json",
        ],
        environment: ENVIRONMENT,
      });
      expect(result.exitCode, JSON.stringify(result.json)).toBe(0);
      const trace = dylibResolutionResultSchema.parse(
        parseEvidence(result.json).normalized_result,
      );
      expect(trace.roots.map(({ architecture }) => architecture)).toEqual([
        "arm64e",
        "arm64e.x1",
        "arm64e",
      ]);
      const environments = trace.findings
        .filter(({ kind }) => kind === "dyld-environment-present")
        .map(({ explanation }) =>
          expected.filter((setting) => explanation.includes(setting)),
        );
      expect(environments).toEqual(expected.map((setting) => [setting]));
    }
  },
);

cliTest(
  "preserves the architecture of a thin trace subject",
  async ({ cli }) => {
    const directory = await createTestTempDirectory("rea-dylib-thin-subject-");
    await writeFiles(directory, {
      tool: machoImage({ cpu: CPU.arm64 }),
    });
    const result = await cli.run({
      arguments: ["trace-dylib-resolution", join(directory, "tool"), "--json"],
      environment: ENVIRONMENT,
    });
    expect(result.exitCode, JSON.stringify(result.json)).toBe(0);
    expect(parseEvidence(result.json).subject?.identity).toMatchObject({
      format: "mach-o",
      architecture: "arm64",
      selection: null,
    });
  },
);

cliTest(
  "names a universal image without the opened slice as the trace subject",
  async ({ cli }) => {
    // Opening the file selects one host slice; a trace covers the slices its
    // own parameters select, so its subject must not inherit that selection.
    const directory = await createTestTempDirectory(
      "rea-dylib-universal-subject-",
    );
    await writeFiles(directory, {
      tool: fatImage([
        { cpu: CPU.arm64, bytes: machoImage({ cpu: CPU.arm64 }) },
        { cpu: CPU.x86_64, bytes: machoImage({ cpu: CPU.x86_64 }) },
      ]),
    });
    for (const [narrowing, architectures] of [
      [[], ["arm64", "x86_64"]],
      [["--architecture", "x86_64"], ["x86_64"]],
    ] as const) {
      const result = await cli.run({
        arguments: [
          "trace-dylib-resolution",
          join(directory, "tool"),
          ...narrowing,
          "--json",
        ],
        environment: ENVIRONMENT,
      });
      expect(result.exitCode, JSON.stringify(result.json)).toBe(0);
      const evidence = parseEvidence(result.json);
      expect(
        dylibResolutionResultSchema
          .parse(evidence.normalized_result)
          .roots.map(({ architecture }) => architecture)
          .sort(),
      ).toEqual(architectures);
      expect(evidence.subject?.identity).toMatchObject({
        format: "mach-o-universal",
        architecture: null,
        selection: null,
      });
    }
  },
);

cliTest(
  "retains definitive load findings for an explicitly selected app library root",
  async ({ cli }) => {
    const app = await fixtureApp();
    const settings = [
      "DYLD_LIBRARY_PATH=/external",
      "DYLD_INSERT_LIBRARIES=/external/injected.dylib",
    ];
    await writeFiles(app, {
      "Contents/Frameworks/libcore.dylib": machoImage({
        fileType: FILE_TYPE.dylib,
        commands: [
          buildVersionCommand(1),
          ...settings.map(dyldEnvironmentCommand),
          dylibCommand(LC.LOAD_DYLIB, "@loader_path/child.dylib"),
          dylibCommand(LC.LOAD_DYLIB, "@loader_path/missing.dylib"),
        ],
      }),
      "Contents/Frameworks/child.dylib": machoImage({
        fileType: FILE_TYPE.dylib,
        commands: [buildVersionCommand(1)],
      }),
    });
    const result = await cli.run({
      arguments: [
        "trace-dylib-resolution",
        app,
        "--root",
        "Contents/Frameworks/libcore.dylib",
        "--json",
      ],
      environment: ENVIRONMENT,
    });
    expect(result.exitCode, JSON.stringify(result.json)).toBe(0);
    const trace = dylibResolutionResultSchema.parse(
      parseEvidence(result.json).normalized_result,
    );
    expect(trace.edges.map(({ resolution }) => resolution.status)).toEqual([
      "resolved",
      "unresolved",
    ]);
    expect(trace.coverage.status).toBe("complete");
    expect(trace.findings.map(({ kind }) => kind)).toContain(
      "required-load-unresolved",
    );
    expect(
      trace.images.find(
        ({ path }) => path === "Contents/Frameworks/libcore.dylib",
      )?.slices[0]?.dyld_environment,
    ).toEqual(settings);
    expect(
      trace.findings.find(({ kind }) => kind === "dyld-environment-present"),
    ).toMatchObject({
      image: "Contents/Frameworks/libcore.dylib",
      basis: "derived",
      explanation: expect.stringContaining(settings[0]!),
    });
  },
);

/** An app bundle whose roots sit among more files than one batch of magic reads. */
const crowdedApp = async (): Promise<string> => {
  const app = await fixtureApp();
  await withBrokenHelper(app);
  const resources: Record<string, string | Uint8Array> = {};
  for (let index = 0; index < 40; index += 1)
    resources[`Contents/Resources/r${index % 4}/file${index}.dat`] = "x".repeat(
      index % 5,
    );
  for (const index of [0, 1, 2])
    resources[`Contents/Resources/r${index}/tool${index}`] = machoImage({
      commands: [buildVersionCommand(1)],
    });
  resources["Contents/Resources/r3/libextra.dylib"] = machoImage({
    fileType: FILE_TYPE.dylib,
  });
  await writeFiles(app, resources);
  return app;
};

describe("trace-dylib-resolution root enumeration", () => {
  cliTest(
    "classifies every Mach-O among more files than one batch of magic reads",
    async ({ cli }) => {
      const app = await crowdedApp();
      const result = await cli.run({
        arguments: ["trace-dylib-resolution", app, "--json"],
        environment: ENVIRONMENT,
      });
      expect(result.exitCode, JSON.stringify(result.json)).toBe(0);
      const trace = dylibResolutionResultSchema.parse(
        (result.json as { normalized_result: unknown }).normalized_result,
      );
      expect(trace.roots.map(({ image }) => image)).toEqual([
        "Contents/Helpers/tool",
        "Contents/MacOS/App",
        "Contents/Resources/r0/tool0",
        "Contents/Resources/r1/tool1",
        "Contents/Resources/r2/tool2",
      ]);
      expect(trace.coverage).toMatchObject({
        status: "partial",
        unparsed_images: ["Contents/Helpers/broken"],
      });
      expect(
        trace.images.find(({ path }) => path === "Contents/Helpers/broken"),
      ).toMatchObject({
        parse_status: "malformed",
        reason: expect.stringContaining("load command"),
        slices: [],
      });
    },
  );

  // This permission fixture requires POSIX mode bits and a non-root caller.
  cliTest.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports an unreadable bundle file found while enumerating roots",
    async ({ cli }) => {
      const app = await crowdedApp();
      const secret = join(app, "Contents/Resources/r2/secret.dat");
      await writeFile(secret, "x");
      await chmod(secret, 0o000);
      try {
        const result = await cli.run({
          arguments: ["trace-dylib-resolution", app, "--json"],
          environment: ENVIRONMENT,
        });
        expect(result.exitCode).toBe(1);
        expect(result.json).toMatchObject({
          details: {
            reason: "unavailable",
            detail: expect.stringContaining(
              "Permission denied (EACCES) reading Contents/Resources/r2/secret.dat",
            ),
          },
        });
      } finally {
        await chmod(secret, 0o644);
      }
    },
  );
});
