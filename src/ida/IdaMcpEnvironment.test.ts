import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createIdaMcpConnection } from "./IdaMcpConnection.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { idaConnectionDependencies } from "../../tests/support/idaConnectionDependencies.js";

afterEach(() => vi.unstubAllEnvs());

it("launches the owned stdio server with only the selected snapshot, never ambient variables", async () => {
  const root = await createTestTempDirectory("rea-ida-environment-");
  const script = join(root, "producer.mjs");
  await writeFile(
    script,
    `
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === 'initialize'
    ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'environment-producer', version: '1' } }
    : request.method === 'tools/list'
      ? { tools: [{ name: 'environment', inputSchema: { type: 'object' } }] }
      : { content: [], structuredContent: { selected: process.env.REA_SELECTED_CONTEXT ?? null, registration: process.env.REA_REGISTRATION_CONTEXT ?? null, ambient: process.env.REA_AMBIENT_CONTEXT ?? null, home: process.env.HOME ?? null, path: process.env.PATH ?? null } };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`,
  );
  vi.stubEnv("REA_SELECTED_CONTEXT", "ambient");
  vi.stubEnv("REA_AMBIENT_CONTEXT", "ambient-only");
  vi.stubEnv("HOME", "/ambient-home");
  vi.stubEnv("PATH", "/ambient-path");
  const environment = {
    REA_SELECTED_CONTEXT: "selected",
    REA_REGISTRATION_CONTEXT: "selected-base",
    HOME: "/selected-home",
    PATH: "/selected-path",
  };
  const registrationEnvironment: Record<string, string> = {
    REA_REGISTRATION_CONTEXT: "registration",
  };
  if (process.platform === "win32") {
    const systemRoot = process.env.SYSTEMROOT;
    if (systemRoot === undefined || systemRoot.length === 0)
      throw new Error(
        "The Windows Node fixture requires its actual SYSTEMROOT.",
      );
    registrationEnvironment.SYSTEMROOT = systemRoot;
  }
  for (const selected of [environment, {}]) {
    const connection = createIdaMcpConnection(
      {
        command: process.execPath,
        args: [script],
        env: registrationEnvironment,
        mode: "attached",
        protocol: "legacy",
        timeoutMs: 5000,
      },
      selected,
      idaConnectionDependencies(),
    );
    environment.REA_SELECTED_CONTEXT = "mutated-after-construction";
    try {
      expect(await connection.connect()).toEqual(["environment"]);
      expect(await connection.call("environment", {})).toEqual({
        selected: selected === environment ? "selected" : null,
        registration: "registration",
        ambient: null,
        home: selected === environment ? "/selected-home" : null,
        path: selected === environment ? "/selected-path" : null,
      });
    } finally {
      await connection.close();
    }
  }
});

it("refuses a stdio reply over the owned frame limit as a fixed transport allowance", async () => {
  const root = await createTestTempDirectory("rea-ida-frame-limit-");
  const script = join(root, "producer.mjs");
  await writeFile(
    script,
    `
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === 'initialize'
    ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'large-reply', version: '1' } }
    : request.method === 'tools/list'
      ? { tools: [{ name: 'large', inputSchema: { type: 'object' } }] }
      : { content: [], structuredContent: { result: 'x'.repeat(8192) } };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`,
  );
  const connection = createIdaMcpConnection(
    {
      command: process.execPath,
      args: [script],
      env: {},
      protocol: "legacy",
      mode: "attached",
      timeoutMs: 5000,
    },
    {},
    idaConnectionDependencies({ maxStdioMessageBytes: 4096 }),
  );
  try {
    expect(await connection.connect()).toEqual(["large"]);
    const failure: unknown = await connection.call("large", {}).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(failure).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
      operation: "large",
      resource: "transport",
      reportedLimits: { max_response_bytes: 4096 },
    });
  } finally {
    await connection.close();
  }
});
