import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, onTestFinished } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const encodingFixture = () => {
  const xml =
    '<?xml version="1.0" encoding="UTF-16"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>App</string><key>CFBundleIdentifier</key><string>dev.rea.encoding</string></dict></plist>';
  const utf16 = Buffer.from(xml, "utf16le");
  const utf8 = xml.replace("UTF-16", "UTF-8");
  const cases = [
    {
      name: "UTF-8 BOM",
      bytes: Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(utf8),
      ]),
      valid: true,
    },
    {
      name: "UTF-16 LE",
      bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), utf16]),
      valid: true,
    },
    {
      name: "UTF-16 BE",
      bytes: Buffer.concat([
        Buffer.from([0xfe, 0xff]),
        Buffer.from(utf16).swap16(),
      ]),
      valid: true,
    },
    {
      name: "unsupported declaration",
      bytes: Buffer.from(utf8.replace("UTF-8", "Shift_JIS")),
      valid: false,
    },
    {
      name: "declaration mismatch",
      bytes: Buffer.from(xml),
      valid: false,
    },
    {
      name: "truncated UTF-16",
      bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), utf16.subarray(0, -1)]),
      valid: false,
    },
    {
      name: "malformed UTF-8 executable",
      bytes: Buffer.concat([
        Buffer.from(utf8.split("<string>App</string>")[0] + "<string>"),
        Buffer.from([0xff]),
        Buffer.from("</string>" + utf8.split("<string>App</string>")[1]),
      ]),
      valid: false,
    },
  ];
  return { utf16, cases };
};

describe.skipIf(process.platform !== "darwin")(
  "app bundle XML byte boundaries",
  () => {
    cliTest(
      "resolves real compiled bundles without changing executable names during decoding",
      async ({ cli, processes }) => {
        const directory = await createTestTempDirectory("rea-bundle-encoding-");
        const app = join(directory, "Example.app");
        const contents = join(app, "Contents");
        await mkdir(join(contents, "MacOS"), { recursive: true });
        const compiled = await processes.run("/usr/bin/xcrun", [
          "clang",
          resolve("tests/conformance/interface-builder/fixture.c"),
          "-o",
          join(contents, "MacOS", "App"),
        ]);
        expect(compiled.exitCode, compiled.stderr).toBe(0);
        const { utf16, cases } = encodingFixture();
        for (const { name, bytes, valid } of cases) {
          await writeFile(join(contents, "Info.plist"), bytes);
          const result = await cli.run({
            arguments: ["inspect-plist", app, "--json"],
            environment: {
              REA_LOG_LEVEL: "silent",
              REA_ANALYSIS_PROVIDER: "auto",
            },
          });
          expect(
            result.exitCode,
            `${name}: ${result.stdout}\n${result.stderr}`,
          ).toBe(valid ? 0 : 1);
          if (valid)
            expect(result.json).toMatchObject({
              normalized_result: {
                value: {
                  CFBundleExecutable: "App",
                  CFBundleIdentifier: "dev.rea.encoding",
                },
                bundle: { executable: "App" },
              },
            });
          else
            expect(result.json).toMatchObject({
              error: "Analysis failed",
              details: {
                path: join(contents, "Info.plist"),
                reason: expect.stringContaining(
                  "app Info.plist is malformed, unsupported, or lacks CFBundleExecutable",
                ),
              },
            });
        }
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [resolve("scripts/rea.mjs"), "mcp"],
          env: {
            PATH: process.env.PATH ?? "",
            REA_LOG_LEVEL: "silent",
            REA_ANALYSIS_PROVIDER: "auto",
          },
          stderr: "pipe",
        });
        const client = new Client({
          name: "bundle-encoding-parity",
          version: "1",
        });
        onTestFinished(async () => {
          try {
            await client.close();
          } finally {
            await transport.close();
          }
        });
        await client.connect(transport);
        await writeFile(
          join(contents, "Info.plist"),
          Buffer.concat([
            Buffer.from([0xfe, 0xff]),
            Buffer.from(utf16).swap16(),
          ]),
        );
        const opened = await client.callTool({
          name: "open_binary",
          arguments: { path: app },
        });
        expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
        const inspected = await client.callTool({
          name: "inspect_plist",
          arguments: {},
        });
        expect(inspected.isError, JSON.stringify(inspected)).not.toBe(true);
        expect(inspected.structuredContent).toMatchObject({
          result: {
            value: {
              CFBundleExecutable: "App",
              CFBundleIdentifier: "dev.rea.encoding",
            },
          },
        });
        await writeFile(
          join(contents, "Info.plist"),
          Buffer.concat([Buffer.from([0xff, 0xfe]), utf16.subarray(0, -1)]),
        );
        const invalid = await client.callTool({
          name: "open_binary",
          arguments: { path: app },
        });
        expect(invalid.isError).toBe(true);
        expect(invalid.structuredContent).toMatchObject({
          error: {
            details: {
              path: join(contents, "Info.plist"),
              reason: expect.stringContaining(
                "app Info.plist is malformed, unsupported, or lacks CFBundleExecutable",
              ),
            },
          },
        });
      },
      45_000,
    );
  },
);
