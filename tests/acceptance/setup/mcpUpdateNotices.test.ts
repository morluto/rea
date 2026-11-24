import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, it } from "vitest";

import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { waitFor } from "../../support/testWait.js";

for (const mode of ["offline", "deferred", "eager"] as const)
  it(`delivers opt-in update notices through the compiled ${mode} MCP entry`, async () => {
    const home = await createTestTempDirectory("rea-mcp-update-notice-");
    const marker = join(home, "lookups");
    const preload = join(home, "registry.mjs");
    // Deterministic public-registry seam; the actual CLI, MCP transport,
    // factory, lazy/eager registration and result codec all remain production.
    await writeFile(
      preload,
      `
      import { appendFile } from 'node:fs/promises';
      globalThis.fetch = async (url) => {
        if (String(url) !== 'https://registry.npmjs.org/-/package/rea-agents/dist-tags')
          throw new Error('unexpected network request');
        await appendFile(${JSON.stringify(marker)}, 'lookup\\n');
        return new Response(JSON.stringify({ latest: '9999.0.0' }));
      };
    `,
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        pathToFileURL(preload).href,
        resolve("scripts/rea.mjs"),
        "mcp",
      ],
      cwd: home,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        USERPROFILE: home,
        HOPPER_LAUNCHER_PATH: join(home, "absent-hopper"),
        ...(mode === "offline" ? {} : { REA_MCP_UPDATE_CHECK: "1" }),
        // Only `compact` leaves the recorded catalog and composes eagerly.
        ...(mode === "eager"
          ? { REA_MCP_OUTPUT_SCHEMA_PROFILE: "compact" }
          : {}),
      },
      stderr: "pipe",
    });
    const client = new Client(
      { name: "update-notice-acceptance", version: "1" },
      { jsonSchemaValidator: createMcpSchemaValidation() },
    );
    const notices: unknown[] = [];
    client.setNotificationHandler("notifications/message", (message) => {
      notices.push(message.params);
    });
    try {
      await client.connect(transport);
      expect(
        (await client.listTools()).tools.some(
          ({ name }) => name === "list_unknowns",
        ),
      ).toBe(true);
      await expect(readFile(marker, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      const call = () =>
        client.callTool({ name: "list_unknowns", arguments: {} });
      const first = await call();
      if (mode !== "offline")
        await waitFor(async () =>
          expect(await readFile(marker, "utf8")).toBe("lookup\n"),
        );
      const second = await call();
      const third = await call();
      expect(first.isError).not.toBe(true);
      expect(first.structuredContent).toBeDefined();
      expect(second.structuredContent).toEqual(first.structuredContent);
      expect(third.structuredContent).toEqual(first.structuredContent);
      expect(second).toEqual(first);
      expect(third).toEqual(first);
      if (mode !== "offline")
        // The marker is written before the server observes the lookup result,
        // so a call sent right after it can still precede the observation.
        // Keep calling until a response carries the single notice.
        await waitFor(async () => {
          expect(await call()).toEqual(first);
          expect(notices).toEqual([
            {
              level: "notice",
              logger: "rea.update",
              data: expect.stringContaining("latest published 9999.0.0"),
            },
          ]);
        });
      else expect(notices).toHaveLength(0);
      if (mode === "offline")
        await expect(readFile(marker, "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
      else expect(await readFile(marker, "utf8")).toBe("lookup\n");
    } finally {
      await client.close();
      await transport.close();
    }
  });
