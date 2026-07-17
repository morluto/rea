import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readClientRegistrationStatuses } from "../src/application/ClientRegistrationStatus.js";

describe("client registration status", () => {
  it("distinguishes aligned, stale, missing, and invalid registrations", async () => {
    const home = await mkdtemp(join(tmpdir(), "rea-registrations-"));
    await Promise.all([
      mkdir(join(home, ".codex")),
      mkdir(join(home, ".cursor")),
      mkdir(join(home, ".gemini")),
      mkdir(join(home, ".claude")),
    ]);
    await writeFile(
      join(home, ".codex/config.toml"),
      '[mcp_servers.rea]\ncommand = "npx"\nargs = ["-y", "rea-agents@latest", "mcp"]\n',
    );
    await writeFile(
      join(home, ".cursor/mcp.json"),
      JSON.stringify({
        mcpServers: {
          rea: { command: "/old/rea", args: ["mcp"], env: { SECRET: "x" } },
        },
      }),
    );
    await writeFile(join(home, ".gemini/settings.json"), "not-json");

    const statuses = await readClientRegistrationStatuses(home, "/current/rea");
    expect(statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ client: "codex", state: "aligned" }),
        expect.objectContaining({
          client: "cursor",
          state: "stale",
          command: ["/old/rea", "mcp"],
        }),
        expect.objectContaining({ client: "gemini_cli", state: "invalid" }),
        expect.objectContaining({ client: "claude_code", state: "missing" }),
      ]),
    );
    expect(JSON.stringify(statuses)).not.toContain("SECRET");
  });

  it("reports an unversioned npx registration as stale", async () => {
    const home = await mkdtemp(join(tmpdir(), "rea-registrations-"));
    await mkdir(join(home, ".codex"));
    await writeFile(
      join(home, ".codex/config.toml"),
      '[mcp_servers.rea]\ncommand = "npx"\nargs = ["-y", "rea-agents", "mcp"]\n',
    );

    const statuses = await readClientRegistrationStatuses(home);

    expect(statuses).toEqual([
      expect.objectContaining({
        client: "codex",
        command: ["npx", "-y", "rea-agents", "mcp"],
        state: "stale",
      }),
    ]);
  });
});
