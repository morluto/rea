import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { z } from "zod";

import { ArtifactProvider } from "../../../src/artifacts/ArtifactProvider.js";
import {
  FILE_TYPE,
  LC,
  buildVersionCommand,
  dylibCommand,
  machoImage,
  rpathCommand,
} from "../../../src/artifacts/apple/MachoImage.fixture.js";
import { dylibResolutionResultSchema } from "../../../src/domain/apple/dylibResolution.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const withClient = async (
  verify: (client: Client) => Promise<void>,
): Promise<void> => {
  const session = createTestBinarySession(new ArtifactProvider());
  const server = createServer(session, session);
  const client = new Client({ name: "dylib-mcp-test", version: "1" });
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
  z.object({ result: z.unknown() }).parse(value).result;

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
    expect(JSON.stringify(changed.structuredContent)).toContain("integrity");
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
    expect(JSON.stringify(called.structuredContent)).toContain("unavailable");
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

it.skipIf(process.getuid?.() === 0)(
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
        expect(JSON.stringify(called.structuredContent)).toMatch(
          /Permission denied \(EACCES\)/u,
        );
      } finally {
        await chmod(parent, 0o755);
      }
    });
  },
);
