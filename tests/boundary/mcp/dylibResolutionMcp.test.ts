import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createHash } from "node:crypto";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { z } from "zod";

import { ArtifactProvider } from "../../../src/artifacts/ArtifactProvider.js";
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
} from "../../../src/artifacts/apple/MachoImage.fixture.js";
import { dylibResolutionResultSchema } from "../../../src/domain/apple/dylibResolution.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";

const withClient = async (
  verify: (client: Client) => Promise<void>,
): Promise<void> => {
  const session = createTestBinarySession(new ArtifactProvider(process.env));
  const server = createServer({ kind: "session", session });
  const client = new Client(
    { name: "dylib-mcp-test", version: "1" },
    { jsonSchemaValidator: createMcpSchemaValidation() },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await verify(client);
  } finally {
    await client.close();
    await server.close();
  }
};

const structuredResult = (value: unknown): unknown =>
  z.object({ normalized_result: z.unknown() }).parse(value).normalized_result;

it("traces dylib resolution for an opened app bundle and rejects a changed target", async () => {
  const app = join(
    await createTestTempDirectory("rea-dylib-mcp-"),
    "Fixture.app",
  );
  await mkdir(join(app, "Contents/MacOS"), { recursive: true });
  await mkdir(join(app, "Contents/Frameworks"), { recursive: true });
  await writeFile(
    join(app, "Contents/Info.plist"),
    "<plist><dict><key>CFBundleExecutable</key><string>App</string></dict></plist>",
  );
  const executable = join(app, "Contents/MacOS/App");
  await writeFile(
    executable,
    machoImage({
      commands: [
        buildVersionCommand(1),
        rpathCommand("@executable_path/../Frameworks"),
        dylibCommand(LC.LOAD_DYLIB, "@rpath/libcore.dylib"),
      ],
    }),
  );
  await writeFile(
    join(app, "Contents/Frameworks/libcore.dylib"),
    machoImage({
      fileType: FILE_TYPE.dylib,
      commands: [buildVersionCommand(1)],
    }),
  );
  await withClient(async (client) => {
    const opened = await client.callTool({
      name: "open_binary",
      arguments: { path: app },
    });
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
    const called = await client.callTool({
      name: "trace_dylib_resolution",
      arguments: {},
    });
    expect(called.isError, JSON.stringify(called.structuredContent)).not.toBe(
      true,
    );
    const trace = dylibResolutionResultSchema.parse(
      structuredResult(called.structuredContent),
    );
    expect(trace.edges).toEqual([
      expect.objectContaining({
        install_name: "@rpath/libcore.dylib",
        resolution: {
          status: "resolved",
          image: "Contents/Frameworks/libcore.dylib",
        },
      }),
    ]);
    const escaping = await client.callTool({
      name: "trace_dylib_resolution",
      arguments: { roots: ["Contents/../../outside"] },
    });
    expect(escaping.isError).toBe(true);

    await writeFile(executable, machoImage({}));
    const changed = await client.callTool({
      name: "trace_dylib_resolution",
      arguments: {},
    });
    expect(changed.isError).toBe(true);
    expect(parseMcpToolError(changed)).toMatchObject({
      error: {
        category: "integrity_mismatch",
        details: { reason: "integrity", integrity_check: "container-identity" },
      },
    });
  });
});

it("traces architecture slices from a universal Mach-O target", async () => {
  const root = await createTestTempDirectory("rea-dylib-universal-");
  const executable = join(root, "Universal");
  const architecture = process.arch === "arm64" ? "x86_64" : "arm64";
  await writeFile(
    executable,
    fatImage(
      [CPU.arm64, CPU.x86_64].map((cpu) => ({
        cpu,
        bytes: machoImage({ cpu, commands: [buildVersionCommand(1)] }),
      })),
    ),
  );

  await withClient(async (client) => {
    const opened = await client.callTool({
      name: "open_binary",
      arguments: { path: executable },
    });
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
    const called = await client.callTool({
      name: "trace_dylib_resolution",
      arguments: { architecture },
    });
    expect(called.isError, JSON.stringify(called.structuredContent)).not.toBe(
      true,
    );
    const evidence = parseEvidence(called.structuredContent);
    const trace = dylibResolutionResultSchema.parse(evidence.normalized_result);
    expect(trace.roots).toEqual([{ image: "Universal", architecture }]);
    expect(evidence.subject?.identity).toMatchObject({
      format: "mach-o-universal",
      architecture: null,
      selection: null,
    });
  });
});

it("rejects targets that are not Mach-O", async () => {
  const directory = await createTestTempDirectory("rea-dylib-mcp-plist-");
  const path = join(directory, "Info.plist");
  await writeFile(path, "<plist><dict/></plist>");
  await withClient(async (client) => {
    const opened = await client.callTool({
      name: "open_binary",
      arguments: { path },
    });
    expect(opened.isError).not.toBe(true);
    const called = await client.callTool({
      name: "trace_dylib_resolution",
      arguments: {},
    });
    expect(called.isError).toBe(true);
    expect(parseMcpToolError(called)).toMatchObject({
      error: { code: "unsupported_target", category: "unsupported_target" },
    });
  });
});

it("reports target kinds that artifact operations cannot inspect as unsupported", async () => {
  const directory = await createTestTempDirectory("rea-artifact-target-");
  const plist = join(directory, "Info.plist");
  await writeFile(plist, "<plist><dict/></plist>");
  const tool = join(directory, "tool");
  await writeFile(tool, machoImage({ commands: [buildVersionCommand(1)] }));
  await withClient(async (client) => {
    for (const [path, operation, requirement] of [
      [plist, "decode_interface_builder", "requires an active .app bundle"],
      // Elsewhere the session reports asset catalogs as unavailable on the
      // host before the provider checks the target kind.
      ...(process.platform === "darwin"
        ? ([
            [plist, "inspect_asset_catalog", "requires an active .app bundle"],
          ] as const)
        : []),
      [tool, "inspect_keyed_archive", "requires an active plist or .app"],
    ] as const) {
      const open = { name: "open_binary", arguments: { path } };
      expect((await client.callTool(open)).isError, path).not.toBe(true);
      const called = await client.callTool({ name: operation, arguments: {} });
      expect(parseMcpToolError(called), operation).toMatchObject({
        error: {
          code: "unsupported_target",
          message: expect.stringContaining(`${operation} at ${path}`),
          details: { reason: expect.stringContaining(requirement) },
        },
      });
    }
  });
});

it("traces a standalone Mach-O file whose name ends in .app", async () => {
  const directory = await createTestTempDirectory("rea-dylib-mcp-file-");
  await writeFile(
    join(directory, "Tool.app"),
    machoImage({
      commands: [
        buildVersionCommand(1),
        dylibCommand(LC.LOAD_DYLIB, "@loader_path/libcore.dylib"),
      ],
    }),
  );
  await writeFile(
    join(directory, "libcore.dylib"),
    machoImage({
      fileType: FILE_TYPE.dylib,
      commands: [buildVersionCommand(1)],
    }),
  );
  await withClient(async (client) => {
    const opened = await client.callTool({
      name: "open_binary",
      arguments: { path: join(directory, "Tool.app") },
    });
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
    const called = await client.callTool({
      name: "trace_dylib_resolution",
      arguments: {},
    });
    expect(called.isError, JSON.stringify(called.structuredContent)).not.toBe(
      true,
    );
    const trace = dylibResolutionResultSchema.parse(
      structuredResult(called.structuredContent),
    );
    expect(trace.edges).toEqual([
      expect.objectContaining({
        resolution: { status: "resolved", image: "libcore.dylib" },
      }),
    ]);
  });
});

/** Trace `app` in `analyzed/`, next to a Mach-O dylib in `outside/`. */
const traceBesideOutside = async (
  commands: readonly Uint8Array[],
  prepare: (analyzed: string) => Promise<void> = async () => {},
): Promise<{
  readonly trace: z.infer<typeof dylibResolutionResultSchema>;
  readonly outsideSha256: string;
}> => {
  const parent = await createTestTempDirectory("rea-dylib-mcp-contained-");
  const analyzed = join(parent, "analyzed");
  await mkdir(analyzed);
  await mkdir(join(parent, "outside"));
  const outside = machoImage({
    fileType: FILE_TYPE.dylib,
    commands: [
      buildVersionCommand(1),
      dylibCommand(LC.ID_DYLIB, "/outside/secret.dylib"),
    ],
  });
  await writeFile(join(parent, "outside/secret.dylib"), outside);
  await writeFile(
    join(analyzed, "app"),
    machoImage({ commands: [buildVersionCommand(1), ...commands] }),
  );
  await prepare(analyzed);
  let trace: z.infer<typeof dylibResolutionResultSchema> | undefined;
  await withClient(async (client) => {
    const opened = await client.callTool({
      name: "open_binary",
      arguments: { path: join(analyzed, "app") },
    });
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
    const called = await client.callTool({
      name: "trace_dylib_resolution",
      arguments: {},
    });
    expect(called.isError, JSON.stringify(called.structuredContent)).not.toBe(
      true,
    );
    trace = dylibResolutionResultSchema.parse(
      structuredResult(called.structuredContent),
    );
  });
  if (trace === undefined) throw new Error("trace_dylib_resolution not called");
  return {
    trace,
    outsideSha256: createHash("sha256").update(outside).digest("hex"),
  };
};

// Windows reads `\` as a separator, but a dyld component is a POSIX name.
it.runIf(process.platform === "win32")(
  "does not read outside the root through backslashes in Windows dyld names",
  async () => {
    const { trace, outsideSha256 } = await traceBesideOutside([
      dylibCommand(LC.LOAD_DYLIB, "@loader_path/..\\outside\\secret.dylib"),
      rpathCommand("@loader_path/..\\outside"),
      dylibCommand(LC.LOAD_DYLIB, "@rpath/secret.dylib"),
    ]);
    expect(trace.edges.map(({ candidates }) => candidates)).toEqual([
      [
        expect.objectContaining({
          path: "..\\outside\\secret.dylib",
          outcome: "absent",
          resolved_path: null,
        }),
      ],
      [
        expect.objectContaining({
          path: "..\\outside/secret.dylib",
          source: "rpath",
          outcome: "absent",
          resolved_path: null,
        }),
      ],
    ]);
    expect(trace.images.map(({ path }) => path)).toEqual(["app"]);
    expect(JSON.stringify(trace)).not.toContain(outsideSha256);
  },
);

it("follows relative symlinks only while they stay inside the root", async () => {
  const { trace, outsideSha256 } = await traceBesideOutside(
    [
      dylibCommand(LC.LOAD_DYLIB, "@loader_path/link/secret.dylib"),
      dylibCommand(LC.LOAD_DYLIB, "@loader_path/sub/lib/libinner.dylib"),
    ],
    // Windows stores these relative link texts as `..\outside` and `..\lib`.
    async (analyzed) => {
      await symlink("../outside", join(analyzed, "link"), "dir");
      await mkdir(join(analyzed, "lib"));
      await mkdir(join(analyzed, "sub"));
      await symlink("../lib", join(analyzed, "sub/lib"), "dir");
      await writeFile(
        join(analyzed, "lib/libinner.dylib"),
        machoImage({
          fileType: FILE_TYPE.dylib,
          commands: [buildVersionCommand(1)],
        }),
      );
    },
  );
  expect(trace.edges.map(({ candidates }) => candidates)).toEqual([
    [
      expect.objectContaining({
        path: "link/secret.dylib",
        outcome: "escapes-target",
        resolved_path: null,
      }),
    ],
    [
      expect.objectContaining({
        path: "sub/lib/libinner.dylib",
        outcome: "resolved",
        resolved_path: "lib/libinner.dylib",
      }),
    ],
  ]);
  expect(trace.images.map(({ path }) => path)).toEqual([
    "app",
    "lib/libinner.dylib",
  ]);
  expect(JSON.stringify(trace)).not.toContain(outsideSha256);
});

it.skipIf(process.platform === "win32")(
  "does not resolve a non-UTF-8 link target as a replacement-character path",
  async () => {
    const { trace } = await traceBesideOutside(
      [dylibCommand(LC.LOAD_DYLIB, "@loader_path/raw-link")],
      async (analyzed) => {
        await symlink(
          Buffer.from([0x6c, 0x69, 0x62, 0xff]),
          join(analyzed, "raw-link"),
        );
        await writeFile(
          join(analyzed, "lib\ufffd"),
          machoImage({
            fileType: FILE_TYPE.dylib,
            commands: [buildVersionCommand(1)],
          }),
        );
      },
    );
    expect(trace.edges[0]?.resolution).toEqual({
      status: "undetermined",
      image: null,
    });
    expect(trace.coverage.status).toBe("partial");
    expect(trace.limitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('"raw-link":"6c6962ff"'),
      ]),
    );
  },
);

it.skipIf(process.platform === "win32")(
  "resolves a POSIX file name that contains backslashes",
  async () => {
    const { trace } = await traceBesideOutside(
      [dylibCommand(LC.LOAD_DYLIB, "@loader_path/..\\outside\\secret.dylib")],
      (analyzed) =>
        writeFile(
          join(analyzed, "..\\outside\\secret.dylib"),
          machoImage({
            fileType: FILE_TYPE.dylib,
            commands: [buildVersionCommand(1)],
          }),
        ),
    );
    expect(trace.edges[0]?.resolution).toEqual({
      status: "resolved",
      image: "..\\outside\\secret.dylib",
    });
  },
);

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "keeps a permission denied while canonicalizing the opened bundle",
  async () => {
    const parent = await createTestTempDirectory("rea-dylib-mcp-revoked-");
    const app = join(parent, "Revoked.app");
    await mkdir(join(app, "Contents/MacOS"), { recursive: true });
    await writeFile(
      join(app, "Contents/Info.plist"),
      "<plist><dict><key>CFBundleExecutable</key><string>App</string></dict></plist>",
    );
    await writeFile(join(app, "Contents/MacOS/App"), machoImage({}));
    await withClient(async (client) => {
      const opened = await client.callTool({
        name: "open_binary",
        arguments: { path: app },
      });
      expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
      await chmod(parent, 0o000);
      try {
        const called = await client.callTool({
          name: "trace_dylib_resolution",
          arguments: {},
        });
        expect(called.isError).toBe(true);
        expect(JSON.stringify(parseMcpToolError(called))).toMatch(
          /Permission denied \(EACCES\)/u,
        );
      } finally {
        await chmod(parent, 0o755);
      }
    });
  },
);

it("scopes embedded dyld observations and dependency uncertainty to each process root", async () => {
  const cases = [
    ["Override", "DYLD_LIBRARY_PATH=/external", true, "conditional"],
    ["Diagnostic", "DYLD_PRINT_RPATHS=1", true, "resolved"],
    ["FallbackHit", "DYLD_FALLBACK_LIBRARY_PATH=/external", true, "resolved"],
    ["Framework", "DYLD_FRAMEWORK_PATH=/external", true, "resolved"],
    ["RootPrefix", "DYLD_ROOT_PATH=/external", true, "resolved"],
    ["Overlay", "DYLD_OVERLAY_PATH=/external", true, "resolved"],
    ["EmptyFallback", "DYLD_FALLBACK_LIBRARY_PATH=", false, "undetermined"],
    ["EmptyVersioned", "DYLD_VERSIONED_LIBRARY_PATH=", false, "unresolved"],
    ["EmptySuffix", "DYLD_IMAGE_SUFFIX=:", false, "unresolved"],
  ] as const;
  const app = join(
    await createTestTempDirectory("rea-dyld-environment-"),
    "Fixture.app",
  );
  const macOS = join(app, "Contents/MacOS");
  await mkdir(macOS, { recursive: true });
  await writeFile(
    join(app, "Contents/Info.plist"),
    "<plist><dict><key>CFBundleExecutable</key><string>Diagnostic</string></dict></plist>",
  );
  const rootImage = (name: string) => `Contents/MacOS/${name}`;
  for (const [name, setting, present] of cases) {
    await writeFile(
      join(macOS, name),
      machoImage({
        commands: [
          buildVersionCommand(1),
          dyldEnvironmentCommand(setting),
          dylibCommand(
            LC.LOAD_DYLIB,
            present ? "@loader_path/child.dylib" : "@loader_path/missing.dylib",
          ),
        ],
      }),
    );
  }
  await writeFile(
    join(macOS, "child.dylib"),
    machoImage({
      fileType: FILE_TYPE.dylib,
      commands: [buildVersionCommand(1)],
    }),
  );
  await withClient(async (client) => {
    const opened = await client.callTool({
      name: "open_binary",
      arguments: { path: app },
    });
    expect(opened.isError, JSON.stringify(opened.structuredContent)).not.toBe(
      true,
    );
    const traceRoots = async (roots: string[]) => {
      const result = await client.callTool({
        name: "trace_dylib_resolution",
        arguments: { roots },
      });
      expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(
        true,
      );
      return dylibResolutionResultSchema.parse(
        structuredResult(result.structuredContent),
      );
    };

    const trace = await traceRoots(cases.map(([name]) => rootImage(name)));
    expect(trace.edges).toHaveLength(cases.length);
    expect(trace.coverage.status).toBe("partial");
    expect(
      trace.limitations.filter((line) =>
        line.includes("request applicable image-selection inputs"),
      ),
    ).toEqual([
      expect.stringContaining(
        `Roots ${rootImage("Override")}, ${rootImage("EmptyFallback")} request`,
      ),
    ]);
    for (const [name, setting, present, status] of cases) {
      const root = rootImage(name);
      expect(
        trace.images.find(({ path }) => path === root)?.slices[0]
          ?.dyld_environment,
        name,
      ).toEqual([setting]);
      const index = trace.edges.findIndex(
        ({ root: edgeRoot }) => edgeRoot === root,
      );
      expect(trace.edges[index]?.resolution, name).toEqual({
        status,
        image: present ? rootImage("child.dylib") : null,
      });
      expect(
        trace.findings.some(
          ({ kind, edge_index }) =>
            kind === "required-load-unresolved" && edge_index === index,
        ),
        name,
      ).toBe(status === "unresolved");
    }

    const definitive = await traceRoots(
      cases
        .filter(
          ([, , , status]) => status === "resolved" || status === "unresolved",
        )
        .map(([name]) => rootImage(name)),
    );
    expect(definitive.coverage.status).toBe("complete");
  });
});

for (const [root, message] of [
  ["Contents/MacOS/Missing", "is not a regular file"],
  ["Contents/MacOS", "is not a regular file"],
  ["Contents/Info.plist", "is not a Mach-O image"],
  ["Contents/MacOS/outside", "resolves outside the analyzed root"],
] as const) {
  const needsFileSymlink = root === "Contents/MacOS/outside";
  // File symlinks on Windows need Developer Mode or an elevated token.
  it.skipIf(process.platform === "win32" && needsFileSymlink)(
    `reports caller-selected root ${root} as invalid input`,
    async () => {
      const app = join(
        await createTestTempDirectory("rea-dylib-roots-"),
        "Fixture.app",
      );
      await mkdir(join(app, "Contents/MacOS"), { recursive: true });
      await writeFile(
        join(app, "Contents/Info.plist"),
        "<plist><dict><key>CFBundleExecutable</key><string>App</string></dict></plist>",
      );
      await writeFile(
        join(app, "Contents/MacOS/App"),
        machoImage({ commands: [buildVersionCommand(1)] }),
      );
      if (needsFileSymlink) await symlink("/bin/ls", join(app, root));
      await withClient(async (client) => {
        const opened = await client.callTool({
          name: "open_binary",
          arguments: { path: app },
        });
        expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
        const called = await client.callTool({
          name: "trace_dylib_resolution",
          arguments: { roots: ["Contents/MacOS/App", root] },
        });
        expect(called.isError, root).toBe(true);
        expect(parseMcpToolError(called), root).toMatchObject({
          error: {
            code: "invalid_request",
            details: {
              issues: [
                {
                  path: ["roots", 1],
                  reason: "invalid_value",
                  message: expect.stringContaining(`Root ${root} ${message}`),
                },
              ],
            },
          },
        });
      });
    },
  );
}
