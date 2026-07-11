import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { configureJsonClient } from "../src/application/Setup.js";

let directory: string | undefined;
afterEach(async () => {
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("JSON client configuration transaction", () => {
  it("preserves existing keys, creates a backup, and reads back the MCP entry", async () => {
    directory = await mkdtemp(join(tmpdir(), "bb-setup-"));
    const configPath = join(directory, "mcp.json");
    const original =
      '{"theme":"dark","mcpServers":{"other":{"command":"other"}}}\n';
    await writeFile(configPath, original);
    const result = await configureJsonClient({ name: "cursor", configPath });
    expect(result.status).toBe("configured");
    expect(await readFile(`${configPath}.better-binary.backup`, "utf8")).toBe(
      original,
    );
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      theme: "dark",
      mcpServers: {
        other: { command: "other" },
        "better-binary": { command: "better-binary-mcp" },
      },
    });
  });

  it("performs no write or second backup when configuration already matches", async () => {
    directory = await mkdtemp(join(tmpdir(), "bb-setup-"));
    const configPath = join(directory, "mcp.json");
    await writeFile(
      configPath,
      '{"mcpServers":{"better-binary":{"command":"better-binary-mcp"}}}\n',
    );
    expect(await configureJsonClient({ name: "cursor", configPath })).toEqual({
      status: "unchanged",
    });
    await expect(
      readFile(`${configPath}.better-binary.backup`, "utf8"),
    ).rejects.toThrow();
  });

  it("refuses malformed existing JSON without overwriting it", async () => {
    directory = await mkdtemp(join(tmpdir(), "bb-setup-"));
    const configPath = join(directory, "mcp.json");
    await writeFile(configPath, "not-json");
    expect(await configureJsonClient({ name: "cursor", configPath })).toEqual({
      status: "failed",
      reason: "readback",
    });
    expect(await readFile(configPath, "utf8")).toBe("not-json");
  });
});
