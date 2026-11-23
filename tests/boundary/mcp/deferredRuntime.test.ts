import { z } from "zod";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { afterAll, beforeAll, expect, it, onTestFinished, vi } from "vitest";
import { artifactMcpCall } from "../../../scripts/lib/artifact-e2e.mjs";
import { closeVerifierResources } from "../../../scripts/lib/verifier-cleanup.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../support/workspace/workspaceFixture.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { PROMPT_CONTRACTS } from "../../../src/contracts/promptContracts.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { evidenceSchema } from "../../../src/domain/evidence.js";
import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisViewResult.js";
import { SERVER_START_FAILED } from "../../../src/main/messages.js";
import { parseConfig } from "../../../src/config/parseConfig.js";
import type { McpServerHandle, McpServe } from "../../../src/main/types.js";
import { phaseGate, settledCause } from "../../support/lifecycleHarness.js";
import { HOT_TOOL_NAMES } from "../../../src/contracts/catalog/catalogDiscovery.js";
import { DatabaseSync } from "node:sqlite";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchemaObject } from "ajv";
import {
  searchGuidanceOutputSchema,
  readGuidanceSectionOutputSchema,
} from "../../../src/contracts/guidanceContracts.js";

const schemaValidation = createMcpSchemaValidation();
const ajv = new Ajv2020({ strict: false });
const validatedToolSchemas = new Set<string>();
let sharedTempRoot = "";
let compileCache = "";
let sqliteProbePath = "";

beforeAll(async () => {
  sharedTempRoot = (await createTestWorkspace("rea-deferred-runtime-shared-"))
    .root;
  compileCache = join(sharedTempRoot, "node-compile");
  sqliteProbePath = join(sharedTempRoot, "app.db");
  const database = new DatabaseSync(sqliteProbePath);
  try {
    database.exec(
      "CREATE TABLE catalog_probe (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO catalog_probe VALUES (7, 'pelican');",
    );
  } finally {
    database.close();
  }
});

afterAll(async () => {
  schemaValidation.clear();
  if (sharedTempRoot !== "") {
    await removeTestWorkspace(sharedTempRoot);
  }
});

const withCompileCache = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  compileCache === "" || environment.NODE_V8_COVERAGE !== undefined
    ? environment
    : { NODE_COMPILE_CACHE: compileCache, ...environment };

const connect = async (
  mode: "legacy" | "auto",
  environment: Record<string, string> = {},
  nodeArguments: readonly string[] = [],
) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...nodeArguments, resolve("scripts/rea.mjs"), "mcp"],
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      REA_LOG_LEVEL: "silent",
      ...(compileCache === "" ? {} : { NODE_COMPILE_CACHE: compileCache }),
      ...environment,
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (value) => {
    stderr += value;
  });
  const client = new Client(
    { name: "deferred-runtime-boundary", version: "1" },
    // Compile output validators for the tools a test calls, not the catalog.
    { versionNegotiation: { mode }, jsonSchemaValidator: schemaValidation },
  );
  onTestFinished(async () => {
    await closeVerifierResources([
      () => client.close(),
      () => transport.close(),
    ]);
  });
  await client.connect(transport);
  return { client, stderr: () => stderr };
};

it.each([
  { mode: "legacy", environment: { REA_MCP_OUTPUT_SCHEMA_PROFILE: "off" } },
  { mode: "auto", environment: {} },
  {
    mode: "auto",
    environment: {
      REA_MCP_OUTPUT_SCHEMA_PROFILE: "compact",
      REA_MCP_TOOL_FAMILIES: "session,application,artifact",
    },
  },
] as const)(
  "discovers and executes cold tools with $mode and $environment",
  async ({ mode, environment }) => {
    const path = sqliteProbePath;
    const { client, stderr } = await connect(mode, {
      ...environment,
      REA_MCP_TOOL_CATALOG_PROFILE: "hot-cold",
    });
    const initial = await client.listTools();
    expect(new Set(initial.tools.map(({ name }) => name))).toEqual(
      new Set([...HOT_TOOL_NAMES, "discover_tools"]),
    );
    if (environment.REA_MCP_OUTPUT_SCHEMA_PROFILE !== "compact")
      expect(
        initial.tools.every((tool) => tool.outputSchema === undefined),
      ).toBe(true);
    for (const tool of initial.tools) {
      const signature = JSON.stringify([tool.inputSchema, tool.outputSchema]);
      if (validatedToolSchemas.has(signature)) continue;
      expect(ajv.validateSchema(tool.inputSchema)).toBe(true);
      if (tool.outputSchema !== undefined)
        expect(ajv.validateSchema(tool.outputSchema as AnySchemaObject)).toBe(
          true,
        );
      validatedToolSchemas.add(signature);
    }
    // Discovery is not recorded; the launcher advertises its compact schema.
    const discovery = initial.tools.find(
      ({ name }) => name === "discover_tools",
    );
    if (discovery === undefined) throw new Error("Missing discover_tools");
    expect(discovery.inputSchema.properties).toEqual({
      query: { type: "string" },
      names: {
        type: "array",
        items: { type: "string", minLength: 1 },
        minItems: 1,
        maxItems: 20,
      },
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 20 },
    });
    expect(JSON.stringify(discovery.inputSchema)).not.toContain('"default"');
    const call = async (name: string, args: Record<string, unknown>) => {
      // Without a listed output schema, call with the listed definition.
      if (environment.REA_MCP_OUTPUT_SCHEMA_PROFILE !== "compact") {
        const definition = (await client.listTools()).tools.find(
          (tool) => tool.name === name,
        );
        if (definition === undefined)
          throw new Error(`Not advertised: ${name}`);
        return client.callTool(
          { name, arguments: args },
          { toolDefinition: definition },
        );
      }
      return artifactMcpCall(client, { name, arguments: args });
    };
    const invalid = await call("discover_tools", {
      names: ["inspect_sqlite_database", "missing_tool"],
    });
    expect(invalid.isError).toBe(true);
    expect(await client.listTools()).toEqual(initial);
    const loaded = await call("discover_tools", {
      names: ["list_unknowns", "discover_tools", "list_unknowns"],
    });
    expect(loaded.structuredContent).toMatchObject({
      loaded_count: initial.tools.length + 1,
      total_matches: 2,
      tools: [
        { name: "list_unknowns" },
        { name: "discover_tools", input_schema: discovery.inputSchema },
      ],
    });
    expect((await call("list_unknowns", {})).isError).not.toBe(true);
    const materialized = await client.listTools();
    expect(materialized.tools).toHaveLength(initial.tools.length + 1);
    expect(
      materialized.tools.find(({ name }) => name === "inspect_sqlite_database"),
    ).toBeUndefined();
    const found = await call("discover_tools", { query: "sqlite", limit: 1 });
    expect(found.structuredContent).toMatchObject({
      total_matches: 1,
      tools: [{ name: "inspect_sqlite_database" }],
    });
    const advertisedSqlite = (await client.listTools()).tools.find(
      ({ name }) => name === "inspect_sqlite_database",
    );
    if (advertisedSqlite === undefined)
      throw new Error("Discovery did not advertise inspect_sqlite_database");
    expect(found.structuredContent).toMatchObject({
      tools: [{ input_schema: advertisedSqlite.inputSchema }],
    });
    const result = await call("inspect_sqlite_database", {
      path,
      table: "catalog_probe",
      columns: ["id", "name"],
      row_limit: 1,
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain("pelican");
    expect(JSON.stringify(result.structuredContent)).toContain("evidence_id");
    expect((await client.listTools()).tools).toHaveLength(
      initial.tools.length + 2,
    );
    if ("REA_MCP_TOOL_FAMILIES" in environment) {
      expect(
        (await call("discover_tools", { names: ["current_address"] })).isError,
      ).toBe(true);
      expect((await client.listTools()).tools).toHaveLength(
        initial.tools.length + 2,
      );
    }
    expect(stderr()).toBe("");
  },
);

const analysisModules = [
  "main/eagerRuntime.js",
  "server/createServer.js",
  "composition/binary.js",
  "contracts/toolContracts.js",
];

const observeRuntimeModules = async () => {
  const directory = await createTestTempDirectory("rea-mcp-module-loads-");
  const log = join(directory, "loaded.jsonl");
  await writeFile(log, "");
  const hook = `data:text/javascript,${encodeURIComponent(`
import { registerHooks } from "node:module";
import { appendFileSync } from "node:fs";
const modules = ${JSON.stringify(analysisModules)};
registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);
    const source = loaded.source?.toString() ?? "";
    const names = modules.filter((name) =>
      url.endsWith("/dist/" + name) || source.includes("//#region dist/" + name + "\\n"));
    if (url.endsWith("/scripts/rea.mjs")) names.push("entrypoint");
    for (const name of names)
      appendFileSync(${JSON.stringify(log)}, JSON.stringify(name) + "\\n");
    return loaded;
  },
});
`)}`;
  return {
    nodeArguments: [`--import=${hook}`],
    loadedModules: async () =>
      new Set(
        (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line): unknown => JSON.parse(line)),
      ),
  };
};

it.each([
  { name: "deferred", environment: {}, eager: false },
  {
    name: "family-scoped deferred",
    environment: { REA_MCP_TOOL_FAMILIES: "artifact,session" },
    eager: false,
  },
  {
    name: "hot/cold deferred",
    environment: { REA_MCP_TOOL_CATALOG_PROFILE: "hot-cold" },
    eager: false,
  },
  {
    name: "compact deferred",
    environment: { REA_MCP_INPUT_SCHEMA_PROFILE: "compact" },
    eager: false,
  },
  {
    name: "output-compact eager",
    environment: { REA_MCP_OUTPUT_SCHEMA_PROFILE: "compact" },
    eager: true,
  },
])(
  "loads compiled analysis at the intended phase for $name startup",
  async ({ environment, eager }) => {
    const { nodeArguments, loadedModules } = await observeRuntimeModules();
    const { client, stderr } = await connect(
      "legacy",
      environment,
      nodeArguments,
    );
    let discovery = await client.listTools();
    await client.listPrompts();
    if (environment.REA_MCP_TOOL_CATALOG_PROFILE === "hot-cold") {
      await client.callTool({
        name: "discover_tools",
        arguments: { names: ["list_unknowns"] },
      });
      discovery = await client.listTools();
    }
    expect(await loadedModules()).toEqual(
      new Set(eager ? ["entrypoint", ...analysisModules] : ["entrypoint"]),
    );
    // Keep output-off coverage too, using this connection's named definition.
    const toolDefinition = discovery.tools.find(
      ({ name }) => name === "list_unknowns",
    );
    if (toolDefinition === undefined) throw new Error("Missing list_unknowns");
    const result = await client.callTool(
      { name: "list_unknowns", arguments: {} },
      { toolDefinition },
    );
    expect(result.isError).not.toBe(true);
    expect(await loadedModules()).toEqual(
      new Set(["entrypoint", ...analysisModules]),
    );
    expect(stderr()).toBe("");
  },
);

it.each(["get", "complete"] as const)(
  "loads the scoped stdio runtime on the first prompt %s request",
  async (operation) => {
    const { nodeArguments, loadedModules } = await observeRuntimeModules();
    const { client, stderr } = await connect(
      "auto",
      { REA_MCP_TOOL_FAMILIES: "artifact,session" },
      nodeArguments,
    );
    const listing = await client.listPrompts();
    expect(listing.prompts.map(({ name }) => name)).toEqual([
      "verify_reconstruction",
      "audit_residual_unknowns",
      "prepare_bounded_process_capture",
    ]);
    expect(await loadedModules()).toEqual(new Set(["entrypoint"]));

    if (operation === "get") {
      const { messages } = await client.getPrompt({
        name: "audit_residual_unknowns",
        arguments: { audit_scope: "scoped startup probe" },
      });
      expect(messages).toEqual([
        {
          role: "user",
          content: {
            type: "text",
            text: expect.stringContaining("scoped startup probe"),
          },
        },
      ]);
    } else {
      const { completion } = await client.complete({
        ref: { type: "ref/prompt", name: "verify_reconstruction" },
        argument: { name: "provider_id", value: "au" },
      });
      expect(completion.values).toEqual(["auto"]);
    }

    expect(await loadedModules()).toEqual(
      new Set(["entrypoint", ...analysisModules]),
    );
    expect(await client.listPrompts()).toEqual(listing);
    expect(stderr()).toBe("");
  },
);

it("records only the output schema material needed by the deferred catalog", async () => {
  const { tools } = z
    .object({
      tools: z.array(
        z.object({
          name: z.string(),
          outputSchema: z.record(z.string(), z.unknown()),
        }),
      ),
    })
    .parse(JSON.parse(await readFile("dist/mcp-catalog.json", "utf8")));
  const objectRoots = tools.filter(
    ({ name, outputSchema }) =>
      name !== "binary_session" && outputSchema.type === "object",
  );
  expect(objectRoots.length).toBeGreaterThan(0);
  expect(
    objectRoots
      .filter(({ outputSchema }) => Object.keys(outputSchema).length !== 1)
      .map(({ name }) => name),
  ).toEqual([]);
  expect(
    tools.find(({ name }) => name === "binary_session")?.outputSchema,
  ).toHaveProperty("properties");
});

it.each([
  { mode: "legacy", environment: { REA_MCP_OUTPUT_SCHEMA_PROFILE: "off" } },
  { mode: "auto", environment: {} },
] as const)(
  "serves discovery and canonical handlers over $mode negotiation",
  async ({ mode, environment }) => {
    const recorded = JSON.parse(
      await readFile("dist/mcp-catalog.json", "utf8"),
    );
    const { client, stderr } = await connect(mode, environment);
    const before = await client.listTools();
    const withoutOutput = ({
      outputSchema: _output,
      ...tool
    }: {
      outputSchema?: unknown;
    }) => tool;
    // Compact output schemas select independent eager composition. The rest
    // of each tool's wire definition must match the deferred catalog.
    if (mode === "legacy") {
      const eager = await connect(mode, {
        REA_MCP_OUTPUT_SCHEMA_PROFILE: "compact",
      });
      const canonical = await eager.client.listTools();
      expect(
        canonical.tools.every((tool) => tool.outputSchema !== undefined),
      ).toBe(true);
      expect(before).toEqual({
        ...canonical,
        tools: canonical.tools.map(withoutOutput),
      });
    }
    expect(before.tools.map(withoutOutput)).toEqual(
      recorded.tools.map(withoutOutput),
    );
    // The default output profile omits the recorded output schemas.
    expect(
      before.tools.filter(({ outputSchema }) => outputSchema !== undefined),
    ).toEqual([]);
    const { prompts } = await client.listPrompts();
    expect(prompts).toEqual(
      PROMPT_CONTRACTS.map((prompt) => ({
        name: prompt.name,
        title: prompt.title,
        description: prompt.description,
        arguments: Object.entries(prompt.arguments).map(([name, argument]) => ({
          name,
          description: argument.description,
          required: argument.required,
        })),
      })),
    );

    expect(prompts).toEqual(
      recorded.prompts.map(
        ({ parameters: _parameters, ...prompt }: Record<string, unknown>) =>
          prompt,
      ),
    );
    // Discovery is checked in full above. Validate each called tool's actual
    // schema without compiling unrelated outputs in every fresh SDK client.
    const results = await Promise.all([
      artifactMcpCall(client, { name: "list_unknowns", arguments: {} }),
      artifactMcpCall(client, {
        name: "list_unknowns",
        arguments: { limit: 1 },
      }),
    ]);
    expect(results.every((result) => result.isError !== true)).toBe(true);
    expect(results.map((result) => result.structuredContent)).toEqual([
      { result: { items: [], total: 0, offset: 0, next_offset: null } },
      { result: { items: [], total: 0, offset: 0, next_offset: null } },
    ]);
    expect(await client.listTools()).toEqual(before);
    const invalid = await artifactMcpCall(client, {
      name: "list_unknowns",
      arguments: { limit: 1.5 },
    });
    expect(invalid.isError).toBe(true);
    expect(invalid._meta?.provenance).toEqual({
      untrusted_content: true,
      source: "analysis_target",
    });
    expect(client.getProtocolEra()).toBe(mode === "auto" ? "modern" : "legacy");
    if (mode === "auto")
      expect(invalid._meta?.["io.modelcontextprotocol/serverInfo"]).toEqual(
        recorded.info,
      );
    expect(stderr()).toBe("");
  },
);

it.each(["legacy", "auto"] as const)(
  "validates non-object-root guidance results from deferred startup over %s",
  async (mode) => {
    const { client, stderr } = await connect(mode);
    const before = await client.listTools();
    const unwrap = (value: unknown) =>
      typeof value === "object" && value !== null && "result" in value
        ? value.result
        : value;
    const found = await client.callTool({
      name: "search_guidance",
      arguments: { query: "exact JavaScript module", limit: 1 },
    });
    expect(found.isError).not.toBe(true);
    const matches = searchGuidanceOutputSchema.parse(
      unwrap(found.structuredContent),
    );
    if (matches.status !== "matches") throw new Error("Expected guide matches");
    const read = await client.callTool({
      name: "read_guidance_section",
      arguments: { locator: matches.matches[0]?.locator },
    });
    expect(read.isError).not.toBe(true);
    expect(
      readGuidanceSectionOutputSchema.parse(unwrap(read.structuredContent))
        .status,
    ).toBe("section");
    expect(await client.listTools()).toEqual(before);
    expect(stderr()).toBe("");
  },
);

it("preserves connection creation time across deferred materialization", async () => {
  const directory = await createTestTempDirectory("rea-mcp-started-at-");
  const clock = join(directory, "clock");
  const startedAt = "2020-01-01T00:00:00.000Z";
  await writeFile(clock, startedAt);
  const hook = `data:text/javascript,${encodeURIComponent(`
import { readFileSync } from "node:fs";
const NativeDate = Date;
globalThis.Date = class extends NativeDate {
  constructor(...args) {
    super(...(args.length === 0 ? [readFileSync(${JSON.stringify(clock)}, "utf8")] : args));
  }
};
`)}`;
  const { client } = await connect("legacy", {}, [`--import=${hook}`]);
  await client.listTools();
  await writeFile(clock, "2021-01-01T00:00:00.000Z");
  const first = await artifactMcpCall(client, {
    name: "binary_session",
    arguments: {},
  });
  expect(first.isError).not.toBe(true);
  expect(first.structuredContent).toMatchObject({
    result: { server_identity: { server: { started_at: startedAt } } },
  });
  const again = await artifactMcpCall(client, {
    name: "binary_session",
    arguments: {},
  });
  expect(again.structuredContent).toMatchObject({
    result: { server_identity: { server: { started_at: startedAt } } },
  });
});

it.each([
  { level: "info", asynchronous: false, errorObject: true },
  { level: "info", asynchronous: true, errorObject: false },
  { level: "silent", asynchronous: false, errorObject: true },
])(
  "logs deferred startup failure with $level logging and asynchronous=$asynchronous",
  ({ level, asynchronous, errorObject }) => {
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
import assert from "node:assert/strict";
import { runDeferred } from "./dist/main/deferredRuntime.js";
import { parseConfig } from "./dist/config/parseConfig.js";
const config = parseConfig({ HOME: process.env.HOME, REA_LOG_LEVEL: ${JSON.stringify(level)} });
assert.equal(config.ok, true);
const output = [];
let closeCalls = 0;
let unregistrations = 0;
const result = await runDeferred({
  env: {},
  writeStderr: (text) => output.push(text),
  setExitCode: () => {},
  registerShutdown: () => () => { unregistrations++; },
  serve: (factory) => {
    const server = factory({});
    const close = server.server.close.bind(server.server);
    server.server.close = async () => { closeCalls++; await close(); };
    const cause = ${errorObject ? 'new Error("transport setup reason")' : '"transport setup reason"'};
    if (${asynchronous}) return Promise.reject(cause);
    throw cause;
  },
}, config.value);
console.log(JSON.stringify({ result, output, closeCalls, unregistrations }));
`,
      ],
      {
        cwd: process.cwd(),
        env: withCompileCache(process.env),
        encoding: "utf8",
        timeout: 10000,
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      result: 1,
      output: [`${SERVER_START_FAILED}\n`],
      closeCalls: 1,
      unregistrations: 1,
    });
    if (level === "silent") {
      expect(child.stderr).toBe("");
    } else {
      expect(JSON.parse(child.stderr)).toMatchObject({
        level: 50,
        application: "rea",
        mode: "mcp",
        layer: "server",
        error: "transport setup reason",
        msg: SERVER_START_FAILED,
      });
    }
  },
);

type DeferredPublisher = Parameters<McpServe>[0];
const legacyContext = { era: "legacy" } as const;

/** Drive the compiled runtime and recorded catalog with a controlled transport. */
const deferredLifecycle = async (
  serve: (
    publish: DeferredPublisher,
    isShutdownRegistered: boolean,
  ) => ReturnType<McpServe>,
) => {
  const runtime = new URL(
    "../../../dist/main/deferredRuntime.js",
    import.meta.url,
  );
  const { runDeferred } = (await import(
    runtime.href
  )) as typeof import("../../../src/main/deferredRuntime.js");
  const config = parseConfig({ REA_LOG_LEVEL: "silent" });
  if (!config.ok) throw config.error;
  let pendingClose: (() => Promise<void>) | undefined;
  let requestClose: (() => void) | undefined;
  const unregister = vi.fn();
  const running = runDeferred(
    {
      env: {},
      serve: (publish) => serve(publish, requestClose !== undefined),
      writeStderr: () => undefined,
      setExitCode: () => undefined,
      registerShutdown: (request) => {
        requestClose = request;
        return unregister;
      },
      captureShutdown: (close) => {
        pendingClose = close;
      },
    },
    config.value,
  );
  return {
    running,
    close: () => {
      if (pendingClose === undefined)
        throw new Error("Missing runtime cleanup owner");
      return pendingClose();
    },
    signal: () => {
      if (requestClose === undefined)
        throw new Error("Missing registered shutdown request");
      requestClose();
    },
    unregister,
  };
};

const trackDeferredServer = async (
  publish: DeferredPublisher,
  beforeClose: () => void,
) => {
  const instance = await publish(legacyContext);
  const server = "server" in instance ? instance.server : instance;
  const close = server.close.bind(server);
  server.close = async () => {
    beforeClose();
    await close();
  };
};

it("retains an SDK server whose cleanup failed after startup rejected", async () => {
  const startupFailure = new Error("serve failed after creating a server");
  const cleanupFailure = new Error("close denied");
  const closeServer = vi.fn(() => {
    if (closeServer.mock.calls.length === 1) throw cleanupFailure;
  });
  const closePeer = vi.fn();
  const fixture = await deferredLifecycle(async (publish, registered) => {
    expect(registered).toBe(true);
    await trackDeferredServer(publish, closeServer);
    await trackDeferredServer(publish, closePeer);
    throw startupFailure;
  });

  try {
    const result = await settledCause(fixture.running);
    expect(result).toBeInstanceOf(AggregateError);
    expect(result).toMatchObject({
      errors: [startupFailure, { errors: [{ errors: [cleanupFailure] }] }],
    });
    expect(closeServer).toHaveBeenCalledTimes(1);
    expect(closePeer).toHaveBeenCalledTimes(1);
    expect(fixture.unregister).not.toHaveBeenCalled();

    fixture.signal();
    await fixture.close();
    await fixture.close();
    expect(closeServer).toHaveBeenCalledTimes(2);
    expect(closePeer).toHaveBeenCalledTimes(1);
    expect(fixture.unregister).toHaveBeenCalledTimes(1);
  } finally {
    await settledCause(fixture.close());
  }
});

it("retries each failed deferred cleanup owner until its own close confirms", async () => {
  const handleFailure = new Error("transport close denied");
  const serverFailure = new Error("SDK server close denied");
  const closeHandle = vi.fn(async () => {
    if (closeHandle.mock.calls.length === 1) throw handleFailure;
  });
  const closePrimary = vi.fn(() => {
    if (closePrimary.mock.calls.length < 3) throw serverFailure;
  });
  const closePeer = vi.fn();
  const fixture = await deferredLifecycle(async (publish) => {
    await trackDeferredServer(publish, closePrimary);
    await trackDeferredServer(publish, closePeer);
    return { close: closeHandle };
  });

  try {
    await expect(fixture.running).resolves.toBe(0);
    await expect(fixture.close()).rejects.toMatchObject({
      errors: [handleFailure, { errors: [serverFailure] }],
    });
    expect(fixture.unregister).not.toHaveBeenCalled();
    await expect(fixture.close()).rejects.toMatchObject({
      errors: [{ errors: [serverFailure] }],
    });
    expect(fixture.unregister).not.toHaveBeenCalled();

    await fixture.close();
    await fixture.close();
    expect(closeHandle).toHaveBeenCalledTimes(2);
    expect(closePrimary).toHaveBeenCalledTimes(3);
    expect(closePeer).toHaveBeenCalledTimes(1);
    expect(fixture.unregister).toHaveBeenCalledTimes(1);
  } finally {
    await settledCause(fixture.close());
  }
});

it("joins late transport publication and seals the deferred server registry before close", async () => {
  const serve = phaseGate<DeferredPublisher, McpServerHandle>();
  const transport = phaseGate();
  const closeServer = vi.fn();
  const closeHandle = vi.fn(() => transport.hold());
  const fixture = await deferredLifecycle((publish) => serve.hold(publish));
  try {
    const publish = await serve.reached(fixture.running, "transport startup");
    fixture.signal();
    const closing = fixture.close();
    await trackDeferredServer(publish, closeServer);
    serve.release({ close: closeHandle });
    await transport.reached(closing, "late transport close");
    const publishAgain = async () => publish(legacyContext);
    await expect(publishAgain()).rejects.toThrow("MCP connection is closed");
    expect(fixture.unregister).not.toHaveBeenCalled();
    transport.release();
    await expect(fixture.running).resolves.toBe(0);
    await closing;
    await expect(publishAgain()).rejects.toThrow("MCP connection is closed");
    await fixture.close();
    expect(closeHandle).toHaveBeenCalledTimes(1);
    expect(closeServer).toHaveBeenCalledTimes(1);
    expect(fixture.unregister).toHaveBeenCalledTimes(1);
  } finally {
    serve.release({ close: closeHandle });
    transport.release();
    await settledCause(fixture.close());
  }
});

it("runs the real static artifact workflow after deferred initialization", async () => {
  const { client } = await connect("legacy");
  const opened = await client.callTool({
    name: "open_binary",
    arguments: { path: resolve("scripts/rea.mjs") },
  });
  expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
  const inspected = await client.callTool({
    name: "inspect_artifact",
    arguments: { detail: "summary" },
  });
  expect(inspected.isError, JSON.stringify(inspected)).not.toBe(true);
  const evidence = evidenceSchema.parse(inspected.structuredContent);
  expect(evidence.operation).toBe("inspect_analysis_view");
  const view = analysisViewResultSchema.parse(evidence.normalized_result);
  expect(view.parent_operation).toBe("inspect_artifact");
  const retained = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: {
        kind: "retained-evidence",
        evidence_id: view.parent_evidence_id,
      },
      view: { kind: "summary" },
    },
  });
  expect(retained.isError, JSON.stringify(retained)).not.toBe(true);
  const closed = await client.callTool({ name: "close_binary", arguments: {} });
  expect(closed.isError, JSON.stringify(closed)).not.toBe(true);
});

const copyCompiledPackage = async (prefix: string): Promise<string> => {
  const directory = await createTestTempDirectory(prefix);
  await cp(resolve("dist"), join(directory, "dist"), { recursive: true });
  await mkdir(join(directory, "scripts/lib"), { recursive: true });
  await cp(resolve("scripts/rea.mjs"), join(directory, "scripts/rea.mjs"));
  // Copy the helpers selected by the package, so this fixture exercises the
  // same launcher files that an installation receives.
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
    files: string[];
  };
  for (const path of manifest.files.filter((file) =>
    file.startsWith("scripts/lib/"),
  ))
    await cp(resolve(path), join(directory, path));
  await cp(resolve("package.json"), join(directory, "package.json"));
  await symlink(
    resolve("node_modules"),
    join(directory, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return directory;
};

it("records the canonical catalog without a host account or ambient configuration", async () => {
  const directory = await copyCompiledPackage("rea-catalog-without-account-");
  await cp(
    resolve("scripts/record-mcp-catalog.mjs"),
    join(directory, "scripts/record-mcp-catalog.mjs"),
  );
  const temporary = join(directory, "temporary");
  await mkdir(temporary);
  const hook = `data:text/javascript,${encodeURIComponent(`
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
os.userInfo = () => { throw new Error("Host account is unavailable"); };
syncBuiltinESMExports();
`)}`;
  const child = spawnSync(
    process.execPath,
    [`--import=${hook}`, join(directory, "scripts/record-mcp-catalog.mjs")],
    {
      cwd: directory,
      env: withCompileCache({
        ...process.env,
        HOME: join(directory, "ambient-home"),
        USERPROFILE: join(directory, "ambient-home"),
        TMPDIR: temporary,
        TMP: temporary,
        TEMP: temporary,
        REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
        REA_MCP_OUTPUT_SCHEMA_PROFILE: "off",
      }),
      encoding: "utf8",
      timeout: 30000,
    },
  );
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toBe("");
  expect(child.stderr).toBe("");
  expect(await readFile(join(directory, "dist/mcp-catalog.json"), "utf8")).toBe(
    await readFile("dist/mcp-catalog.json", "utf8"),
  );
  expect(
    await readFile(join(directory, "dist/recordedMcpCatalog.js"), "utf8"),
  ).toBe(await readFile("dist/recordedMcpCatalog.js", "utf8"));
  expect(await readdir(temporary)).toEqual([]);
});

it.each([
  { failures: ["client"], producerFails: false },
  { failures: ["client", "server", "session"], producerFails: true },
  { failures: [], producerFails: true },
])(
  "preserves producer failure=$producerFails and settles every recorder owner with cleanup failures=$failures",
  async ({ failures, producerFails }) => {
    const directory = await createTestTempDirectory("rea-catalog-cleanup-");
    const log = join(directory, "cleanup.jsonl");
    const temporary = join(directory, "temporary");
    const script = join(directory, "scripts", "record-mcp-catalog.mjs");
    await mkdir(temporary);
    await mkdir(join(directory, "dist"));
    await mkdir(join(directory, "scripts"));
    await cp(resolve("scripts/record-mcp-catalog.mjs"), script);
    // Fault injection tests recorder ownership, not provider or SDK behavior.
    const close = (owner: string) => `async () => {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(${JSON.stringify(log)}, JSON.stringify(${JSON.stringify(owner)}) + "\\n");
      if (${JSON.stringify(failures)}.includes(${JSON.stringify(owner)}))
        throw new Error(${JSON.stringify(`${owner} cleanup failed`)});
      return { ok: true };
    }`;
    const replacements = {
      "/dist/server/createServer.js": `export const createServer = () => ({ connect: async () => {}, close: ${close("server")} });`,
      "/dist/composition/binary.js": `export const createBinarySession = () => ({ close: ${close("session")} });`,
      "/dist/config/parseConfig.js":
        "export const parseConfig = () => ({ ok: true, value: {} });",
      "/dist/logger.js": "export const silentLogger = {};",
      "/dist/contracts/promptContracts.js":
        "export const PROMPT_CONTRACTS = [];",
      // The recorder derives Evidence-input names from these contracts. This
      // fault injection has no tools, so the derived list stays empty.
      "/dist/contracts/toolContracts.js": "export const TOOL_CONTRACTS = [];",
      "/dist/domain/evidenceInputContract.js":
        "export const getEvidenceInputContract = () => ({ hasEvidenceReferenceAlternative: false });",
      "/dist/contracts/toolSchemaMetadata.js":
        "export const toolOutputSchemaWithMetadata = () => { throw new Error('No fixture tools'); };",
      "/dist/contracts/toolFamilies.js":
        "export const toolFamilyId = () => { throw new Error('No fixture tools'); };",
      "/dist/contracts/promptToolFamilyScope.js":
        "export const requiredPromptTools = () => { throw new Error('No fixture prompts'); };",
    };
    const clientModule = `data:text/javascript,${encodeURIComponent(`
export class Client {
  async connect() {}
  async listTools() {
    if (${JSON.stringify(producerFails)}) throw new Error("catalog generation failed");
    return { tools: [] };
  }
  async listPrompts() { return { prompts: [] }; }
  getServerVersion() {}
  getServerCapabilities() {}
  getInstructions() {}
  close = ${close("client")};
}
export const InMemoryTransport = { createLinkedPair: () => [null, null] };
`)}`;
    const hook = `data:text/javascript,${encodeURIComponent(`
import { registerHooks } from "node:module";
const replacements = ${JSON.stringify(replacements)};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@modelcontextprotocol/client")
      return { url: ${JSON.stringify(clientModule)}, shortCircuit: true };
    const replacement = Object.entries(replacements).find(([path]) => specifier.endsWith(path));
    return replacement === undefined ? next(specifier, context)
      : { url: "data:text/javascript," + encodeURIComponent(replacement[1]), shortCircuit: true };
  },
});
`)}`;
    const child = spawnSync(process.execPath, [`--import=${hook}`, script], {
      cwd: directory,
      env: withCompileCache({
        ...process.env,
        TMPDIR: temporary,
        TMP: temporary,
        TEMP: temporary,
      }),
      encoding: "utf8",
      timeout: 10000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(
      (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line): unknown => JSON.parse(line))
        .sort(),
    ).toEqual(["client", "server", "session"]);
    for (const owner of failures)
      expect(child.stderr).toContain(`${owner} cleanup failed`);
    if (producerFails) {
      expect(child.stderr).toContain("Error: catalog generation failed");
      if (failures.length > 0)
        expect(
          child.stderr.indexOf("Error: catalog generation failed"),
        ).toBeLessThan(child.stderr.indexOf(`${failures[0]} cleanup failed`));
    }
    if (failures.length > 0)
      expect(child.stderr).toContain("AggregateError: Catalog cleanup failed");
    else expect(child.stderr).not.toContain("AggregateError");
    expect(await readdir(temporary)).toHaveLength(failures.length > 0 ? 1 : 0);
    expect(await readdir(join(directory, "dist"))).toEqual(
      producerFails ? [] : ["mcp-catalog.json"],
    );
  },
);

it("rejects a corrupted build-owned catalog before starting the connection", async () => {
  const directory = await copyCompiledPackage("rea-corrupted-mcp-catalog-");
  await writeFile(join(directory, "dist/mcp-catalog.json"), "{}");
  const child = spawnSync(
    process.execPath,
    [join(directory, "scripts/rea.mjs"), "mcp"],
    {
      cwd: directory,
      env: withCompileCache(process.env),
      input: "",
      encoding: "utf8",
      timeout: 10000,
    },
  );
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(1);
  expect(child.stdout).toBe("");
  expect(child.stderr).toBe(`${SERVER_START_FAILED}\n`);
});

it("keeps the outer SDK as the only raw-input owner during deferred materialization", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { runDeferred } from "./dist/main/deferredRuntime.js";
import { parseConfig } from "./dist/config/parseConfig.js";
const parsed = parseConfig({ REA_LOG_LEVEL: "silent" });
assert.equal(parsed.ok, true);
const input = new PassThrough();
const output = new PassThrough();
const received = [];
input.on("data", chunk => received.push(Buffer.from(chunk)));
const writes = [];
const responses = [];
let pendingOutput = "";
output.on("data", chunk => {
  pendingOutput += chunk.toString("utf8");
  for (;;) {
    const boundary = pendingOutput.indexOf("\\n");
    if (boundary < 0) break;
    responses.push(JSON.parse(pendingOutput.slice(0, boundary)));
    pendingOutput = pendingOutput.slice(boundary + 1);
  }
});
const until = async (predicate) => {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Deferred SDK control did not settle");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
let entered = false;
let release;
const held = new Promise(resolve => { release = resolve; });
let close;
let hookCloses = 0;
const result = await runDeferred({
  env: { REA_LOG_LEVEL: "silent" }, stdin: input,
  serve: (factory, options) => serveStdio(context => {
    const server = factory(context);
    server.registerCloseHook(async () => { hookCloses++; });
    return server;
  }, { ...options, transport: new StdioServerTransport(input, output) }),
  loadOptionalProviders: async () => { entered = true; await held; return {}; },
  captureShutdown: owned => { close = owned; },
  registerShutdown: () => () => {}, writeStderr: text => { throw new Error(text); }, setExitCode: () => {},
}, parsed.value);
assert.equal(result, 0);
const send = value => { const bytes = Buffer.from(JSON.stringify(value) + "\\n"); writes.push(bytes); input.write(bytes); };
try {
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "deferred-input-owner", version: "1" } } });
  await until(() => responses.some(value => value.id === 1));
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_unknowns", arguments: {} } });
  await until(() => entered);
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_unknowns", arguments: { limit: 1 } } });
  release();
  await until(() => responses.some(value => value.id === 2) && responses.some(value => value.id === 3));
  await close();
  await close();
  assert.equal(hookCloses, 1);
  assert.deepEqual(Buffer.concat(received), Buffer.concat(writes));
  assert.equal(responses.filter(value => value.id === 2).length, 1);
  assert.equal(responses.filter(value => value.id === 3).length, 1);
  console.log("ONE_INPUT_OWNER");
} finally { release(); await close?.(); input.destroy(); output.destroy(); }
`,
    ],
    {
      cwd: process.cwd(),
      env: withCompileCache(process.env),
      encoding: "utf8",
      timeout: 15000,
    },
  );
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toBe("ONE_INPUT_OWNER\n");
});

it("distinguishes an exhausted production discovery page from an unmatched query", async () => {
  const { client } = await connect(
    "auto",
    {
      REA_MCP_TOOL_CATALOG_PROFILE: "hot-cold",
    },
    ["--max-old-space-size=1024"],
  );
  const discover = (arguments_: Record<string, unknown>) =>
    artifactMcpCall(client, { name: "discover_tools", arguments: arguments_ });
  const catalogIdentity = async () => {
    const status = await artifactMcpCall(client, {
      name: "binary_session",
      arguments: {},
    });
    return toolContract("binary_session").outputSchema.parse(
      status.structuredContent,
    ).result.server_identity.catalog;
  };
  const identity = await catalogIdentity();
  let changed = 0;
  client.setNotificationHandler("notifications/tools/list_changed", () => {
    changed++;
  });
  const subscription = await client.listen({ toolsListChanged: true });
  onTestFinished(() => subscription.close());
  const first = await discover({ query: "inspect", limit: 1 });
  await expect.poll(() => changed).toBe(1);
  const { total_matches: total } = z
    .object({ total_matches: z.number().int().positive() })
    .parse(first.structuredContent);
  const last = await discover({
    query: "inspect",
    offset: total - 1,
    limit: 1,
  });
  expect(last.structuredContent).toMatchObject({
    total_matches: total,
    next_offset: null,
    next_step: expect.stringContaining("Call the returned tool"),
  });
  const before = await client.listTools();
  // Each newly visible page publishes one event. Wait for both before
  // probing pages that must leave the catalog alone.
  await expect.poll(() => changed).toBe(2);
  for (const offset of [total, total + 1]) {
    const page = await discover({ query: "inspect", offset, limit: 1 });
    expect(page.structuredContent).toMatchObject({
      total_matches: total,
      tools: [],
      next_offset: null,
      next_step: expect.stringContaining("offset 0"),
    });
    expect(await client.listTools()).toEqual(before);
  }
  const unmatched = await discover({
    query: "rea-no-such-tool-keyword-9995",
    limit: 1,
  });
  expect(unmatched.structuredContent).toMatchObject({
    total_matches: 0,
    tools: [],
    next_offset: null,
    next_step: expect.stringContaining("No matches."),
  });
  expect(await client.listTools()).toEqual(before);
  expect(changed).toBe(2);
  expect(await catalogIdentity()).toEqual(identity);
});
