import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { expect } from "vitest";
import { z } from "zod";

import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { workspaceCliTest as test } from "../../support/cli/workspaceCliFixture.js";
import type { TestWorkspace } from "../../support/workspace/workspaceFixture.js";

const isolatedEnvironment = (workspace: TestWorkspace) => ({
  // Discovery still needs the host's process-ownership prerequisites, such as ps.
  PATH: process.env.PATH ?? "",
  HOME: workspace.home,
  USERPROFILE: workspace.home,
  APPDATA: workspace.path("appdata"),
  LOCALAPPDATA: workspace.path("localappdata"),
  XDG_CONFIG_HOME: workspace.path("config"),
  XDG_CACHE_HOME: workspace.path("cache"),
  TEMP: workspace.root,
  TMP: workspace.root,
  ...(process.platform === "win32"
    ? { SystemRoot: process.env.SystemRoot ?? "" }
    : {}),
  HOPPER_LAUNCHER_PATH: workspace.path("missing-hopper"),
  REA_LOG_LEVEL: "silent",
  REA_JEB_MCP_URL: "http://127.0.0.1:8425/mcp/",
  REA_JEB_MCP_TIMEOUT_MS: "1.5",
});

test("retains the selected endpoint when a direct JEB connection fails", async ({
  cli,
  workspace,
}) => {
  const server = createServer((_request, response) => {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Missing loopback listener address");
    const endpoint = `HTTP://127.0.0.1:0${address.port}/mcp`;
    const result = await cli.run({
      arguments: ["inspect-jeb-client", "--json"],
      environment: {
        ...isolatedEnvironment(workspace),
        REA_JEB_MCP_TIMEOUT_MS: "3000",
        REA_JEB_MCP_URL: endpoint,
      },
    });
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.json).toMatchObject({
      code: "capability_unavailable",
      details: {
        diagnostics: { endpoint },
        reason: expect.stringContaining("not found"),
      },
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: workspace.root,
      env: {
        ...isolatedEnvironment(workspace),
        REA_JEB_MCP_TIMEOUT_MS: "3000",
        REA_JEB_MCP_URL: endpoint,
      },
      stderr: "pipe",
    });
    const client = new Client({
      name: "jeb-endpoint-acceptance",
      version: "1",
    });
    try {
      await client.connect(transport);
      const definition = (await client.listTools()).tools.find(
        ({ name }) => name === "inspect_jeb_client",
      );
      if (definition === undefined) throw new Error("Missing JEB tool");
      const refusal = parseMcpToolError(
        await client.callTool(
          { name: "inspect_jeb_client", arguments: {} },
          { toolDefinition: definition },
        ),
      );
      expect(refusal.error).toMatchObject({
        code: "capability_unavailable",
        details: { diagnostics: { endpoint } },
      });
    } finally {
      await client.close();
      await transport.close();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
  }
});

test("keeps compiled CLI discovery usable while JEB rejects its malformed timeout", async ({
  cli,
  workspace,
}) => {
  const environment = isolatedEnvironment(workspace);
  for (const command of ["capabilities", "providers"]) {
    const result = await cli.run({
      arguments: [command, "--json"],
      environment,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      capabilities: expect.arrayContaining([
        expect.objectContaining({
          provider: expect.objectContaining({ id: "rea-artifact-graph" }),
        }),
      ]),
    });
  }
  const refusal = await cli.run({
    arguments: ["inspect-jeb-client", "--json"],
    environment,
  });
  expect(refusal.exitCode, refusal.stderr).toBe(1);
  expect(refusal.json).toMatchObject({
    code: "configuration_invalid",
    details: { settings: [{ setting: "REA_JEB_MCP_TIMEOUT_MS" }] },
  });
  const doctor = await cli.run({
    arguments: ["doctor", "--provider", "jeb", "--json"],
    environment,
  });
  expect(doctor.exitCode, doctor.stderr).toBe(1);
  expect(doctor.json).toMatchObject({
    healthy: false,
    providerInspections: expect.arrayContaining([
      expect.objectContaining({
        id: "jeb",
        configured: true,
        available: false,
        registrationEnvironment: {
          REA_JEB_MCP_URL: environment.REA_JEB_MCP_URL,
        },
      }),
    ]),
    checks: expect.arrayContaining([
      expect.objectContaining({
        name: "jeb-request-timeout",
        ok: false,
        classification: "config_drift",
        detail: "REA_JEB_MCP_TIMEOUT_MS: must be a positive decimal integer",
      }),
    ]),
  });
  const validDoctor = await cli.run({
    arguments: ["doctor", "--provider", "jeb", "--json"],
    environment: { ...environment, REA_JEB_MCP_TIMEOUT_MS: "900000" },
  });
  expect(validDoctor.exitCode, validDoctor.stderr).toBe(1);
  expect(validDoctor.json).toMatchObject({
    healthy: false,
    providerInspections: expect.arrayContaining([
      expect.objectContaining({
        id: "jeb",
        configured: true,
        available: false,
      }),
    ]),
    scope_checks: expect.arrayContaining([
      expect.objectContaining({
        name: "jeb-availability",
        ok: false,
        classification: "unknown",
      }),
    ]),
  });
});

test("registers an unprobed JEB endpoint without advertising service readiness or contacting it", async ({
  cli,
  workspace,
}) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(503);
    response.end("Not a compatible JEB service");
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Expected a bound loopback endpoint");
    const endpoint = `http://127.0.0.1:${address.port}/mcp/`;
    const environment = {
      ...isolatedEnvironment(workspace),
      CODEX_HOME: workspace.path("codex"),
      REA_JEB_MCP_URL: endpoint,
      REA_JEB_MCP_TIMEOUT_MS: "900000",
    };
    const doctor = await cli.run({
      arguments: ["doctor", "--provider", "jeb", "--json"],
      environment,
    });
    expect(doctor.exitCode, doctor.stderr).toBe(1);
    expect(doctor.json).toMatchObject({
      healthy: false,
      scope_checks: expect.arrayContaining([
        expect.objectContaining({
          name: "jeb-availability",
          ok: false,
          classification: "unknown",
        }),
      ]),
    });
    expect(requests).toBe(0);
    const result = await cli.run({
      arguments: [
        "setup",
        "--client",
        "codex",
        "--skill=false",
        "--yes",
        "--json",
      ],
      environment,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      status: "ready",
      doctor: {
        providerInspections: expect.arrayContaining([
          expect.objectContaining({
            id: "jeb",
            configured: true,
            available: false,
            registrationEnvironment: { REA_JEB_MCP_URL: endpoint },
            checks: expect.arrayContaining([
              expect.objectContaining({
                name: "availability",
                ok: false,
                classification: "unknown",
              }),
            ]),
          }),
        ]),
      },
    });
    const summary = z
      .object({ doctor: z.object({ availableProviders: z.array(z.string()) }) })
      .parse(result.json);
    expect(summary.doctor.availableProviders).not.toContain("jeb");
    expect(
      await readFile(workspace.path("codex/config.toml"), "utf8"),
    ).toContain(endpoint);
    expect(requests).toBe(0);
  } finally {
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
  }
});

test.for([
  {
    name: "omitted",
    endpoint: undefined,
    timeout: undefined,
    configured: false,
  },
  { name: "empty", endpoint: "", timeout: undefined, configured: false },
  {
    name: "timeout-only",
    endpoint: undefined,
    timeout: "900000",
    configured: true,
  },
])(
  "diagnoses the default JEB endpoint without persisting an implicit override: $name",
  async ({ endpoint, timeout, configured }, { cli, workspace }) => {
    const environment = {
      ...isolatedEnvironment(workspace),
      CODEX_HOME: workspace.path("codex"),
      REA_JEB_MCP_URL: endpoint,
      REA_JEB_MCP_TIMEOUT_MS: timeout,
    };
    const doctor = await cli.run({
      arguments: ["doctor", "--provider", "jeb", "--json"],
      environment,
    });
    expect(doctor.exitCode, doctor.stderr).toBe(1);
    expect(doctor.json).toMatchObject({
      healthy: false,
      providerInspections: expect.arrayContaining([
        expect.objectContaining({
          id: "jeb",
          configured,
          available: false,
          registrationEnvironment: {},
          checks: expect.arrayContaining([
            expect.objectContaining({
              name: "registration",
              ok: true,
              code: null,
              detail: expect.stringContaining("http://127.0.0.1:8425/mcp"),
            }),
            expect.objectContaining({
              name: "availability",
              code: "not_probed",
              classification: "unknown",
            }),
          ]),
        }),
      ]),
    });
    const setup = await cli.run({
      arguments: [
        "setup",
        "--client",
        "codex",
        "--skill=false",
        "--yes",
        "--json",
      ],
      environment,
    });
    expect(setup.exitCode, setup.stderr).toBe(0);
    expect(setup.json).toMatchObject({ status: "ready" });
    const saved = await readFile(workspace.path("codex/config.toml"), "utf8");
    if (endpoint === undefined) expect(saved).not.toContain("REA_JEB_MCP_URL");
    else expect(saved).toContain('REA_JEB_MCP_URL = ""');
    if (timeout !== undefined) {
      expect(saved).toContain("REA_JEB_MCP_TIMEOUT_MS");
      expect(saved).toContain(timeout);
    }
  },
);

test("starts production stdio MCP and retains peer requests around a JEB configuration refusal", async ({
  workspace,
}) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("scripts/rea.mjs"), "mcp"],
    cwd: workspace.root,
    env: isolatedEnvironment(workspace),
    stderr: "pipe",
  });
  const client = new Client({ name: "jeb-isolation-acceptance", version: "1" });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  try {
    await client.connect(transport);
    await client.ping();
    const definition = (await client.listTools()).tools.find(
      ({ name }) => name === "inspect_jeb_client",
    );
    if (definition === undefined)
      throw new Error(`Production MCP omitted inspect_jeb_client: ${stderr}`);
    const refusal = parseMcpToolError(
      await client.callTool(
        { name: "inspect_jeb_client", arguments: {} },
        { toolDefinition: definition },
      ),
    );
    expect(refusal.error).toMatchObject({
      code: "configuration_invalid",
      details: { settings: [{ setting: "REA_JEB_MCP_TIMEOUT_MS" }] },
    });
    await client.ping();
  } finally {
    await client.close();
    await transport.close();
  }
});
