import { expect } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { webSourceLocationFixture } from "../fixtures/webSourceLocation.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";
import { hasWindowsNativeAuthority } from "../../src/process/WindowsAuthority.js";

const ownedProcessAuthorityAvailable =
  process.platform !== "win32" || hasWindowsNativeAuthority("win32");

cliTest.skipIf(!ownedProcessAuthorityAvailable)(
  "accepts numeric UTF-16 coordinates and runs the actual owned source-map codec without a browser",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-source-map-cli-");
    const fixture = webSourceLocationFixture();
    await mkdir(join(root, "files", "modules"), { recursive: true });
    await writeFile(join(root, "files", "modules", "main.js"), fixture.source);
    const manifest = join(root, "manifest.json");
    const map = join(root, "app.js.map");
    await writeFile(manifest, JSON.stringify(fixture.manifest));
    await writeFile(map, fixture.sourceMap.text);
    const response = await cli.run({
      arguments: [
        "trace-web-source-location",
        manifest,
        "0",
        map,
        fixture.sourceMap.url,
        "1",
        "0",
        "--json",
      ],
      environment: {
        REA_LOG_LEVEL: "silent",
        REA_BROWSER_EXECUTABLE: "relative-unconfigured-browser",
      },
      timeoutMs: 15000,
    });
    expect(response.exitCode).toBe(0);
    expect(response.json).toMatchObject({
      normalized_result: {
        source: { script_index: 0 },
        source_map: { association: "caller-selected" },
        generated_offset: 0,
        execution: "unknown",
        matches: [{ content: { text: "original" } }],
        runtime: { id: "node-v8" },
      },
    });
    const invalid = await cli.run({
      arguments: [
        "trace-web-source-location",
        manifest,
        "0",
        map,
        fixture.sourceMap.url,
        "2",
        "0",
        "--json",
      ],
      environment: { REA_LOG_LEVEL: "silent" },
      timeoutMs: 15000,
    });
    expect(invalid.exitCode).toBe(1);
    expect(invalid.json).toMatchObject({
      code: "invalid_request",
      details: { issues: [{ path: ["generated_position"] }] },
    });
  },
);
