import {
  Client,
  SdkError,
  SdkErrorCode,
  type Tool,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { cp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, expect, it, onTestFinished, vi } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { awaitAcknowledgement } from "../../fixtures/lifecycleAcknowledgement.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { closeVerifierResources } from "../../../scripts/lib/verifier-cleanup.mjs";
import { HOT_TOOL_NAMES } from "../../../src/catalogDiscovery.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  readGuidanceSectionOutputSchema,
  searchGuidanceOutputSchema,
} from "../../../src/contracts/guidanceContracts.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { evidenceBundleSchema } from "../../../src/domain/evidenceBundle.js";
import { apiContractSchema } from "../../../src/domain/apiContract/apiContract.js";
import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisView.js";
import { SERVER_START_FAILED } from "../../../src/main/messages.js";

const validation = createMcpSchemaValidation();
afterAll(() => validation.clear());

type Configuration = {
  mode: "legacy" | "auto";
  input: "full" | "compact";
  output: "full" | "compact" | "off";
  catalog: "full" | "hot-cold";
};

// Pairwise inputs across the protocol/output/catalog product: twelve independent
// clients, not an exhaustive 24-cell product. Compact/off output intentionally
// use eager composition; full output must remain deferred until a domain call.
const matrix: Configuration[] = ["legacy", "auto"].flatMap((mode, m) =>
  ["full", "compact", "off"].flatMap((output, o) =>
    ["full", "hot-cold"].map((catalog, c) => ({
      mode: mode as Configuration["mode"],
      output: output as Configuration["output"],
      catalog: catalog as Configuration["catalog"],
      input: (m + o + c) % 2 === 0 ? "full" : "compact",
    })),
  ),
);

const lifecycleConfigurations = [
  { mode: "legacy", input: "full", output: "full", catalog: "full" },
  { mode: "auto", input: "compact", output: "full", catalog: "hot-cold" },
] as const;

const connect = async (
  configuration: Configuration,
  nodeArguments: readonly string[] = [],
  entrypoint = resolve("scripts/rea.mjs"),
) => {
  const root = await createTestTempDirectory("rea-deferred-schema-profiles-");
  const log = join(root, "runtime-loaded");
  await writeFile(log, "");
  const hook = `data:text/javascript,${encodeURIComponent(`
import { registerHooks } from "node:module";
import { appendFileSync } from "node:fs";
registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);
    if (url.endsWith("/dist/main/eagerRuntime.js") ||
        loaded.source?.toString().includes("//#region dist/main/eagerRuntime.js\\n"))
      appendFileSync(${JSON.stringify(log)}, "loaded\\n");
    return loaded;
  }
});
`)}`;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [`--import=${hook}`, ...nodeArguments, entrypoint, "mcp"],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      REA_LOG_LEVEL: "silent",
      REA_MCP_INPUT_SCHEMA_PROFILE: configuration.input,
      REA_MCP_OUTPUT_SCHEMA_PROFILE: configuration.output,
      REA_MCP_TOOL_CATALOG_PROFILE: configuration.catalog,
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const client = new Client(
    { name: "deferred-schema-profile-client", version: "1" },
    {
      versionNegotiation: { mode: configuration.mode },
      jsonSchemaValidator: validation,
    },
  );
  let subscription: Awaited<ReturnType<Client["listen"]>> | undefined;
  const close = () =>
    closeVerifierResources([
      () => subscription?.close() ?? Promise.resolve(),
      () => client.close(),
      () => transport.close(),
    ]);
  onTestFinished(close);
  await client.connect(transport);
  let definitions = new Map<string, Tool>();
  const list = async () => {
    const result = await client.listTools();
    definitions = new Map(result.tools.map((tool) => [tool.name, tool]));
    return result;
  };
  const definition = (name: string) => {
    const found = definitions.get(name);
    if (found === undefined) throw new Error(`Tool not advertised: ${name}`);
    return found;
  };
  const call = (
    name: string,
    arguments_: Record<string, unknown>,
    signal?: AbortSignal,
  ) =>
    client.callTool(
      { name, arguments: arguments_ },
      {
        toolDefinition: definition(name),
        ...(signal === undefined ? {} : { signal }),
      },
    );
  const changed = vi.fn();
  client.setNotificationHandler("notifications/tools/list_changed", changed);
  if (configuration.mode === "auto")
    subscription = await client.listen({ toolsListChanged: true });
  const load = async (names: string[]) => {
    if (configuration.catalog === "hot-cold") {
      const result = await call("discover_tools", { names });
      expect(result.isError).not.toBe(true);
      await list();
      expect(result.structuredContent).toMatchObject({
        tools: [...new Set(names)].map((name) => ({
          name,
          input_schema: definition(name).inputSchema,
        })),
      });
    }
  };
  return {
    root,
    client,
    list,
    definition,
    call,
    load,
    changed,
    close,
    runtimeLoaded: async () => (await readFile(log, "utf8")).length > 0,
    stderr: () => stderr,
  };
};

const unwrapGuidance = (value: unknown) =>
  typeof value === "object" && value !== null && "result" in value
    ? value.result
    : value;

const verifyGuidance = async (
  f: Awaited<ReturnType<typeof connect>>,
  configuration: Configuration,
) => {
  // The first domain call uses a root union, before any incidental materialization.
  const found = await f.call("search_guidance", {
    query: "exact JavaScript module",
    limit: 1,
  });
  expect(found.isError).not.toBe(true);
  expect(found.structuredContent).toHaveProperty(
    configuration.mode === "legacy" ? "result.status" : "status",
    "matches",
  );
  expect(
    searchGuidanceOutputSchema.parse(unwrapGuidance(found.structuredContent))
      .status,
  ).toBe("matches");
  expect(await f.runtimeLoaded()).toBe(true);

  const missing = await f.call("search_guidance", {
    query: "unmatched_qzxv",
  });
  expect(
    searchGuidanceOutputSchema.parse(unwrapGuidance(missing.structuredContent))
      .status,
  ).toBe("no_matches");
  const badGuidance = await f.call("search_guidance", { query: 17 });
  expect(parseMcpToolError(badGuidance).error.code).toBe("invalid_request");
  expect(badGuidance.structuredContent).toBeUndefined();

  const guide = await f.call("search_guidance", {
    query: "inspect_analysis_view OpenAPI",
    limit: 1,
  });
  const matches = searchGuidanceOutputSchema.parse(
    unwrapGuidance(guide.structuredContent),
  );
  if (matches.status !== "matches")
    throw new Error("Expected compiled tool guidance");
  expect(matches.matches[0]?.guide).toBe("tools/inspect_analysis_view.md");
  const read = await f.call("read_guidance_section", {
    locator: matches.matches[0]?.locator,
  });
  expect(read.isError).not.toBe(true);
  expect(
    readGuidanceSectionOutputSchema.parse(
      unwrapGuidance(read.structuredContent),
    ).status,
  ).toBe("section");
};

it.each(matrix)(
  "preserves schemas, guidance and retained Evidence over $mode with $input inputs, $output outputs and $catalog catalog",
  async (configuration) => {
    const f = await connect(configuration);
    const initial = await f.list();
    expect(f.client.getProtocolEra()).toBe(
      configuration.mode === "legacy" ? "legacy" : "modern",
    );
    const eager = configuration.output !== "full";
    expect(await f.runtimeLoaded()).toBe(eager);
    if (configuration.catalog === "hot-cold") {
      expect(new Set(initial.tools.map(({ name }) => name))).toEqual(
        new Set([...HOT_TOOL_NAMES, "discover_tools"]),
      );
    } else {
      expect(initial.tools.map(({ name }) => name)).toContain(
        "inspect_analysis_view",
      );
    }
    await f.load([
      "search_guidance",
      "read_guidance_section",
      "inspect_api_contract",
      "inspect_analysis_view",
    ]);
    expect(await f.runtimeLoaded()).toBe(eager);
    const before = await f.list();
    for (const name of [
      "search_guidance",
      "read_guidance_section",
      "inspect_api_contract",
      "inspect_analysis_view",
    ]) {
      const definition = f.definition(name);
      expect(
        validation.assertions.validateSchema(definition.inputSchema),
        name,
      ).toBe(true);
      if (configuration.output === "off")
        expect(definition.outputSchema, name).toBeUndefined();
      else {
        if (definition.outputSchema === undefined)
          throw new Error(`Missing output schema: ${name}`);
        expect(
          validation.assertions.validateSchema(definition.outputSchema),
          name,
        ).toBe(true);
      }
    }
    await verifyGuidance(f, configuration);
    expect(await f.list()).toEqual(before);

    const path = join(f.root, "api.json");
    await writeFile(
      path,
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Schema matrix", version: "1" },
        paths: {
          "/items": { get: { operationId: "listItems" } },
          "/items/{id}": { delete: { operationId: "removeItem" } },
        },
      }),
    );
    const produced = await f.call("inspect_api_contract", {
      path,
      detail: "complete",
    });
    expect(produced.isError).not.toBe(true);
    const parent = parseEvidence(produced.structuredContent);
    expect(
      apiContractSchema.parse(parent.normalized_result).operations,
    ).toMatchObject([
      {
        method: "GET",
        path: "/items",
        declared_id: "listItems",
        source_pointer: "/paths/~1items/get",
      },
      {
        method: "DELETE",
        path: "/items/{id}",
        declared_id: "removeItem",
        source_pointer: "/paths/~1items~1{id}/delete",
      },
    ]);
    await rm(path);
    const source = {
      kind: "retained-evidence",
      evidence_id: parent.evidence_id,
    };
    const view = {
      kind: "api-contract",
      collection: "operations",
      paths: ["/items"],
      fields: ["method", "path"],
      limit: 1,
    };
    const malformed = { source, view: { ...view, offset: -1 } };
    expect(
      toolContract("inspect_analysis_view").inputSchema.safeParse(malformed)
        .success,
    ).toBe(false);
    expect(
      validation.assertions.validate(
        f.definition("inspect_analysis_view").inputSchema,
        { source, view },
      ),
    ).toBe(true);
    // Compact advertisements may safely retain more canonical constraints.
    // Exact rejection belongs to the full projection and the server parser.
    if (configuration.input === "full")
      expect(
        validation.assertions.validate(
          f.definition("inspect_analysis_view").inputSchema,
          malformed,
        ),
      ).toBe(false);
    const rejected = await f.call("inspect_analysis_view", malformed);
    expect(parseMcpToolError(rejected).error.code).toBe("invalid_request");
    expect(rejected.structuredContent).toBeUndefined();
    const selected = await f.call("inspect_analysis_view", { source, view });
    expect(selected.isError).not.toBe(true);
    const evidence = parseEvidence(selected.structuredContent);
    expect(
      analysisViewResultSchema.parse(evidence.normalized_result),
    ).toMatchObject({
      parent_evidence_id: parent.evidence_id,
      items: [{ method: "GET", path: "/items", state: "declared" }],
    });
    expect(evidence.evidence_links).toEqual([parent.evidence_id]);
    const repeated = await f.call("inspect_analysis_view", { source, view });
    expect(parseEvidence(repeated.structuredContent)).toEqual(evidence);
    const unknown = await f.call("inspect_analysis_view", {
      source: { ...source, evidence_id: `ev_${"b".repeat(64)}` },
      view,
    });
    expect(parseMcpToolError(unknown).error.code).toBe(
      "evidence_integrity_mismatch",
    );
    expect(unknown.structuredContent).toBeUndefined();
    const notifications = f.changed.mock.calls.length;
    await f.load([
      "inspect_analysis_view",
      "search_guidance",
      "inspect_analysis_view",
    ]);
    expect(f.changed).toHaveBeenCalledTimes(notifications);
    expect(notifications).toBe(configuration.catalog === "hot-cold" ? 1 : 0);
    expect(await f.list()).toEqual(before);
    expect(f.stderr()).toBe("");
  },
);

const verifyReconnect = async ({
  configuration,
  names,
  parent,
  view,
}: {
  configuration: Configuration;
  names: string[];
  parent: ReturnType<typeof parseEvidence>;
  view: Record<string, unknown>;
}) => {
  const source = { kind: "retained-evidence", evidence_id: parent.evidence_id };
  const next = await connect(configuration);
  const fresh = await next.list();
  expect(fresh.tools.map(({ name }) => name)).toEqual(
    configuration.catalog === "hot-cold"
      ? names.filter(
          (name) => HOT_TOOL_NAMES.has(name) || name === "discover_tools",
        )
      : names,
  );
  expect(await next.runtimeLoaded()).toBe(false);
  await next.load(["inspect_analysis_view"]);
  const expired = await next.call("inspect_analysis_view", {
    source,
    view,
  });
  expect(parseMcpToolError(expired).error.code).toBe(
    "evidence_integrity_mismatch",
  );
  const portable = await next.call("inspect_analysis_view", {
    source: { kind: "inline", evidence: parent },
    view,
  });
  expect(portable.isError).not.toBe(true);
  expect(
    analysisViewResultSchema.parse(
      parseEvidence(portable.structuredContent).normalized_result,
    ),
  ).toMatchObject({
    parent_evidence_id: parent.evidence_id,
    items: [{ method: "GET", path: "/peer" }],
  });
  expect(next.stderr()).toBe("");
};

it.each(lifecycleConfigurations)(
  "keeps a peer callable after cancellation during $mode/$catalog materialization, then reconnects with fresh visibility and Evidence",
  async (configuration) => {
    const control = await createTestTempDirectory(
      "rea-materialization-cancellation-",
    );
    const started = join(control, "started");
    const release = join(control, "release");
    // Hold the real lazy module at import time. Every request still passes
    // through the production SDK transport, registration and canonical parser.
    const gate = `await (async () => {
      const fs = await import("node:fs/promises");
      await fs.writeFile(${JSON.stringify(started)}, "started");
      for (let attempt = 0; attempt < 1000; attempt++) {
        try { await fs.access(${JSON.stringify(release)}); return; } catch {}
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      throw new Error("Fixture materialization was not released");
    })();\n`;
    const hook = `data:text/javascript,${encodeURIComponent(`
import { registerHooks } from "node:module";
registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);
    if (url.endsWith("/dist/main/eagerRuntime.js") ||
        loaded.source?.toString().includes("//#region dist/main/eagerRuntime.js\\n")) {
      return { ...loaded, source: ${JSON.stringify(gate)} + loaded.source.toString() };
    }
    return loaded;
  }
});
`)}`;
    const f = await connect(configuration, [`--import=${hook}`]);
    await f.list();
    await f.load([
      "inspect_api_contract",
      "inspect_analysis_view",
      "export_evidence_bundle",
    ]);
    expect(await f.runtimeLoaded()).toBe(false);
    const before = await f.list();
    const path = join(control, "peer.json");
    const cancelledPath = join(control, "cancelled.json");
    const api = (id: string) =>
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Cancellation fixture", version: "1" },
        paths: { "/peer": { get: { operationId: id } } },
      });
    await writeFile(path, api("retainedPeer"));
    await writeFile(cancelledPath, api("cancelledMustNotRun"));
    const controller = new AbortController();
    const reason = new SdkError(
      SdkErrorCode.RequestTimeout,
      "Cancelled during shared deferred initialization",
    );
    const cancelled = f.call(
      "inspect_api_contract",
      { path: cancelledPath, detail: "complete" },
      controller.signal,
    );
    const rejected = expect(cancelled).rejects.toBe(reason);
    const pending: Promise<unknown>[] = [cancelled, rejected];
    try {
      const acknowledged = vi.waitFor(
        async () => expect(await readFile(started, "utf8")).toBe("started"),
        { timeout: 2000, interval: 10 },
      );
      pending.push(acknowledged);
      await awaitAcknowledgement(
        acknowledged,
        cancelled,
        "public deferred materialization",
      );
      const peer = f.call("inspect_api_contract", { path, detail: "complete" });
      pending.push(peer);
      controller.abort(reason);
      await rejected;
      // A round trip while import is held also proves the catalog/protocol
      // remain responsive after sending the cancellation notification.
      expect(await f.list()).toEqual(before);
      await writeFile(release, "release");
      const result = await peer;
      expect(result.isError).not.toBe(true);
      const parent = parseEvidence(result.structuredContent);
      expect(
        apiContractSchema.parse(parent.normalized_result).operations,
      ).toMatchObject([
        { path: "/peer", method: "GET", declared_id: "retainedPeer" },
      ]);
      expect(await f.runtimeLoaded()).toBe(true);
      expect(await f.list()).toEqual(before);
      const exportPath = join(control, "bundle.json");
      expect(
        (await f.call("export_evidence_bundle", { path: exportPath })).isError,
      ).not.toBe(true);
      const bundle = evidenceBundleSchema.parse(
        JSON.parse(await readFile(exportPath, "utf8")),
      );
      expect(
        bundle.records
          .filter(({ operation }) => operation === "inspect_api_contract")
          .map(({ evidence_id }) => evidence_id),
      ).toEqual([parent.evidence_id]);
      await rm(path);
      const source = {
        kind: "retained-evidence",
        evidence_id: parent.evidence_id,
      };
      const view = {
        kind: "api-contract",
        collection: "operations",
        fields: ["method", "path"],
        limit: 1,
      };
      const selected = await f.call("inspect_analysis_view", { source, view });
      expect(selected.isError).not.toBe(true);
      expect(
        analysisViewResultSchema.parse(
          parseEvidence(selected.structuredContent).normalized_result,
        ),
      ).toMatchObject({
        parent_evidence_id: parent.evidence_id,
        items: [{ method: "GET", path: "/peer" }],
      });
      await f.close();

      await verifyReconnect({
        configuration,
        names: before.tools.map(({ name }) => name),
        parent,
        view,
      });
      expect(f.stderr()).toBe("");
    } finally {
      controller.abort(reason);
      await writeFile(release, "release");
      await Promise.allSettled(pending);
    }
  },
);

it.each(lifecycleConfigurations)(
  "recovers from a malformed first domain call over $mode/$catalog without replacing advertised schemas",
  async (configuration) => {
    const f = await connect(configuration);
    await f.list();
    await f.load(["search_guidance", "read_guidance_section"]);
    const before = await f.list();
    expect(await f.runtimeLoaded()).toBe(false);
    const malformed = await f.call("search_guidance", { query: 17 });
    expect(parseMcpToolError(malformed).error.code).toBe("invalid_request");
    expect(malformed.structuredContent).toBeUndefined();
    expect(await f.runtimeLoaded()).toBe(true);
    await verifyGuidance(f, configuration);
    expect(await f.list()).toEqual(before);
    expect(f.stderr()).toBe("");
  },
);

it.each(lifecycleConfigurations)(
  "keeps discovery responsive and rejects domain calls after $mode/$catalog materialization fails",
  async (configuration) => {
    // Fault the lazy module's evaluation, preserving its real imports/exports.
    // Transport startup and discovery must still use the production server.
    const hook = `data:text/javascript,${encodeURIComponent(`
import { registerHooks } from "node:module";
registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);
    if (url.endsWith("/dist/main/eagerRuntime.js") ||
        loaded.source?.toString().includes("//#region dist/main/eagerRuntime.js\\n"))
      return { ...loaded, source: 'throw new Error("PRIVATE fixture initialization failure");\\n' + loaded.source.toString() };
    return loaded;
  }
});
`)}`;
    const f = await connect(configuration, [`--import=${hook}`]);
    await f.list();
    await f.load(["search_guidance", "read_guidance_section"]);
    const before = await f.list();
    expect(await f.runtimeLoaded()).toBe(false);
    for (const query of ["inspect_analysis_view OpenAPI", "unmatched_qzxv"]) {
      const result = await f.call("search_guidance", { query });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(JSON.stringify(result)).toContain(SERVER_START_FAILED);
      expect(JSON.stringify(result)).not.toContain("PRIVATE");
    }
    expect(await f.runtimeLoaded()).toBe(true);
    await f.load(["search_guidance", "read_guidance_section"]);
    expect(await f.list()).toEqual(before);
    expect(f.stderr()).toBe("");
  },
);

it.each(lifecycleConfigurations)(
  "materializes through a prompt operation over $mode/$catalog and preserves schemas and live Evidence completion",
  async (configuration) => {
    const f = await connect(configuration);
    await f.list();
    await f.load([
      "inspect_api_contract",
      "export_evidence_bundle",
      "search_guidance",
      "read_guidance_section",
    ]);
    const toolsBefore = await f.list();
    const promptsBefore = await f.client.listPrompts();
    expect(promptsBefore.prompts.map(({ name }) => name)).toContain(
      "verify_reconstruction",
    );
    expect(await f.runtimeLoaded()).toBe(false);
    const complete = () =>
      f.client.complete({
        ref: { type: "ref/prompt", name: "verify_reconstruction" },
        argument: { name: "comparison_evidence_id", value: "ev_" },
      });
    // Use retrieval first on legacy, completion first on modern; neither
    // operation should execute an analysis or create Evidence observations.
    if (configuration.mode === "auto")
      expect((await complete()).completion.values).toEqual([]);
    const prompt = await f.client.getPrompt({
      name: "investigate_feature",
      arguments: { feature: "declared GET /items" },
    });
    expect(await f.runtimeLoaded()).toBe(true);
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0]).toMatchObject({
      role: "user",
      content: {
        type: "text",
        text: expect.stringContaining('"feature":"declared GET /items"'),
      },
    });
    if (configuration.mode === "legacy")
      expect((await complete()).completion.values).toEqual([]);
    await expect(
      f.client.getPrompt({
        name: "investigate_feature",
        arguments: { feature: "   " },
      }),
    ).rejects.toThrow(/Invalid arguments/u);
    expect(await f.client.listPrompts()).toEqual(promptsBefore);
    expect(await f.list()).toEqual(toolsBefore);
    const exportPath = join(f.root, "prompt-only.json");
    expect(
      (await f.call("export_evidence_bundle", { path: exportPath })).isError,
    ).not.toBe(true);
    expect(
      evidenceBundleSchema.parse(JSON.parse(await readFile(exportPath, "utf8")))
        .records,
    ).toEqual([]);
    const path = join(f.root, "completion.json");
    await writeFile(
      path,
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Prompt completion", version: "1" },
        paths: { "/items": { get: { operationId: "listItems" } } },
      }),
    );
    const result = await f.call("inspect_api_contract", {
      path,
      detail: "complete",
    });
    expect(result.isError).not.toBe(true);
    const evidence = parseEvidence(result.structuredContent);
    expect(
      apiContractSchema.parse(evidence.normalized_result).operations,
    ).toMatchObject([{ method: "GET", path: "/items" }]);
    expect((await complete()).completion.values).toEqual([
      evidence.evidence_id,
    ]);
    await verifyGuidance(f, configuration);
    expect(await f.list()).toEqual(toolsBefore);
    expect(f.stderr()).toBe("");
  },
);

it.each(lifecycleConfigurations)(
  "validates stale and unavailable guidance replies and recovers after bundle repair over $mode/$catalog",
  async (configuration) => {
    const runtime = await createTestTempDirectory(
      "rea-guidance-failure-runtime-",
    );
    // Exercise the shipped dispatcher and runtime with an independently
    // editable guide bundle. Only locked dependencies are linked to the build.
    for (const path of ["dist", "skills", "scripts", "package.json"])
      await cp(resolve(path), join(runtime, path), { recursive: true });
    await symlink(
      resolve("node_modules"),
      join(runtime, "node_modules"),
      "junction",
    );
    const guidePath = join(
      runtime,
      "skills/reverse-engineer-anything/SKILL.md",
    );
    const original = await readFile(guidePath);
    const f = await connect(
      configuration,
      [],
      join(runtime, "scripts/rea.mjs"),
    );
    await f.list();
    await f.load(["search_guidance", "read_guidance_section"]);
    const before = await f.list();
    expect(await f.runtimeLoaded()).toBe(false);
    const search = async (query: string, cursor?: string) => {
      const result = await f.call("search_guidance", {
        query,
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(result.isError).not.toBe(true);
      return searchGuidanceOutputSchema.parse(
        unwrapGuidance(result.structuredContent),
      );
    };
    const found = await search("inspect_analysis_view OpenAPI");
    if (found.status !== "matches" || found.matches[0] === undefined)
      throw new Error("Expected a compiled guidance locator");
    expect(found.matches[0].guide).toBe("tools/inspect_analysis_view.md");
    const locator = found.matches[0].locator;
    const page = await search("inspect_analysis_view");
    if (page.status !== "matches" || page.next_cursor === undefined)
      throw new Error("Expected a guidance continuation token");
    const read = async () => {
      const result = await f.call("read_guidance_section", { locator });
      expect(result.isError).not.toBe(true);
      return readGuidanceSectionOutputSchema.parse(
        unwrapGuidance(result.structuredContent),
      );
    };
    await writeFile(
      guidePath,
      Buffer.concat([
        original,
        Buffer.from("\n<!-- bundle drift fixture -->\n"),
      ]),
    );
    expect((await read()).status).toBe("stale_locator");
    expect(
      (await search("inspect_analysis_view", page.next_cursor)).status,
    ).toBe("stale_continuation");
    const invalid = await f.call("read_guidance_section", {
      locator: "../../outside.md",
    });
    expect(parseMcpToolError(invalid).error.code).toBe("invalid_request");
    expect(invalid.structuredContent).toBeUndefined();
    await rm(guidePath);
    expect((await search("inspect_analysis_view OpenAPI")).status).toBe(
      "bundle_unavailable",
    );
    expect((await read()).status).toBe("bundle_unavailable");
    await writeFile(guidePath, original);
    expect(await search("inspect_analysis_view OpenAPI")).toMatchObject({
      status: "matches",
      bundle_sha256: found.bundle_sha256,
    });
    expect(await read()).toMatchObject({
      status: "section",
      guide: "tools/inspect_analysis_view.md",
      locator,
      content: expect.stringContaining("api-contract"),
    });
    expect(await f.runtimeLoaded()).toBe(true);
    expect(await f.list()).toEqual(before);
    expect(f.stderr()).toBe("");
  },
);
