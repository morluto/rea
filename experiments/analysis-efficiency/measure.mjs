import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  NATIVE_ARTIFACTS,
  measureNativeEntry,
  nativeEntrySeed,
} from "./native-entry.mjs";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Ajv2020 } from "ajv/dist/2020.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { values } = parseArgs({
  options: {
    "runtime-root": { type: "string", default: root },
    revision: { type: "string" },
    artifact: { type: "string" },
    path: { type: "string" },
    providers: { type: "string" },
    output: { type: "string" },
    delivery: { type: "string", default: "complete" },
    "native-question": { type: "string", default: "entry" },
    "javascript-question": { type: "string", default: "inventory" },
    schemas: { type: "string", default: "default" },
  },
});
if (
  !values.revision ||
  !values.artifact ||
  !values.path ||
  !values.output ||
  !isAbsolute(values.path) ||
  !isAbsolute(values.output) ||
  !["complete", "summary"].includes(values.delivery) ||
  !["entry", "entry-and-main", "entry-views"].includes(
    values["native-question"],
  ) ||
  !["inventory", "selected"].includes(values["javascript-question"]) ||
  !["default", "selected"].includes(values.schemas) ||
  (!NATIVE_ARTIFACTS.includes(values.artifact) &&
    values["native-question"] !== "entry") ||
  (values.artifact !== "jq" &&
    values["native-question"] === "entry-and-main") ||
  (values.artifact !== "obsidian.asar" &&
    values["javascript-question"] !== "inventory")
)
  throw new Error(
    "Use --revision SHA --artifact ID --path ABS --output NEW_ABS_DIR [--runtime-root ABS] [--providers JSON] [--delivery complete|summary]",
  );

const sha = (text) => createHash("sha256").update(text).digest("hex");
const fileSha = async (path) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};
const corpus = JSON.parse(
  await readFile(new URL("./corpus.json", import.meta.url), "utf8"),
);
const artifact = corpus.artifacts.find(({ id }) => id === values.artifact);
if (!artifact) throw new Error("Select an artifact from the pinned corpus");
const inputSha = await fileSha(values.path);
if (
  artifact.sha256 !== inputSha ||
  artifact.bytes !== (await stat(values.path)).size
)
  throw new Error("Selected bytes differ from the pinned public corpus");
const selectedProviders = values.providers
  ? JSON.parse(await readFile(values.providers, "utf8"))
  : {};
if (
  selectedProviders === null ||
  Array.isArray(selectedProviders) ||
  typeof selectedProviders !== "object" ||
  Object.values(selectedProviders).some((value) => typeof value !== "string")
)
  throw new Error(
    "--providers must contain an object of explicit string settings",
  );
const providerPolicyText = await readFile(
  new URL("./provider-environment.json", import.meta.url),
  "utf8",
);
const providerPolicy = JSON.parse(providerPolicyText);
const undeclaredProviderKeys = Object.keys(process.env).filter(
  (key) =>
    (providerPolicy.namespace_prefixes.some((prefix) =>
      key.startsWith(prefix),
    ) ||
      providerPolicy.additional_keys.includes(key)) &&
    !Object.hasOwn(selectedProviders, key),
);
if (undeclaredProviderKeys.length > 0)
  throw new Error(
    `Declare inherited provider settings explicitly in --providers: ${undeclaredProviderKeys.sort().join(", ")}. Values are not logged.`,
  );
await mkdir(values.output, { recursive: false, mode: 0o700 });
const runtimeFiles = [];
const fingerprintTree = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await fingerprintTree(path);
    else if (entry.isFile())
      runtimeFiles.push({
        path: path.slice(resolve(values["runtime-root"]).length + 1),
        sha256: await fileSha(path),
      });
    else throw new Error("Runtime fingerprint does not follow symlinks");
  }
};
await fingerprintTree(resolve(values["runtime-root"], "dist"));
await fingerprintTree(resolve(values["runtime-root"], "bridge"));
runtimeFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
await writeFile(
  resolve(values.output, "runtime-files.json"),
  JSON.stringify(runtimeFiles),
);
const fingerprints = {
  measure_source_sha256: await fileSha(fileURLToPath(import.meta.url)),
  native_workflow_source_sha256: await fileSha(
    fileURLToPath(new URL("./native-entry.mjs", import.meta.url)),
  ),
  runtime_files_sha256: sha(JSON.stringify(runtimeFiles)),
  runtime_dispatcher_sha256: await fileSha(
    resolve(values["runtime-root"], "scripts/rea.mjs"),
  ),
  package_lock_sha256: await fileSha(
    resolve(values["runtime-root"], "package-lock.json"),
  ),
};
const clientVersion = JSON.parse(
  await readFile(
    resolve(root, "node_modules/@modelcontextprotocol/client/package.json"),
    "utf8",
  ),
).version;
const serverVersion = JSON.parse(
  await readFile(
    resolve(
      values["runtime-root"],
      "node_modules/@modelcontextprotocol/server/package.json",
    ),
    "utf8",
  ),
).version;

class ToolFailure extends Error {
  constructor(value) {
    super("REA returned a tool error");
    this.value = value;
  }
}

const client = new Client({ name: "rea-analysis-efficiency", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(values["runtime-root"], "scripts/rea.mjs"), "mcp"],
  env: { ...process.env, ...selectedProviders },
  stderr: "pipe",
});
const diagnostics = [];
const calls = [];
const catalogDefinitions = new Map();
const pendingRpc = new Map();
let activeCall;
const started = performance.now();
let connectedMs, catalogMs, catalogBytes, catalogInputBytes, result, failure;
const decode = (reply) =>
  reply.structuredContent ??
  JSON.parse(
    reply.content.find((item) => item.type === "text")?.text ?? "null",
  );
const call = async (name, arguments_) => {
  const toolDefinition =
    values.schemas === "selected" ? catalogDefinitions.get(name) : undefined;
  if (values.schemas === "selected" && toolDefinition === undefined)
    throw new Error(`No live advertised definition for ${name}`);
  const began = performance.now();
  const progress = [];
  const rpc = {};
  activeCall = { began, rpc };
  try {
    const reply = await client.callTool(
      { name, arguments: arguments_ },
      {
        ...(toolDefinition === undefined ? {} : { toolDefinition }),
        timeout: 600_000,
        onprogress: (update) =>
          progress.push({ elapsed_ms: performance.now() - began, ...update }),
      },
    );
    const elapsedMs = performance.now() - began;
    const encodingBegan = performance.now();
    const text = JSON.stringify(reply);
    const value = decode(reply);
    calls.push({
      name,
      arguments: arguments_,
      elapsed_ms: elapsedMs,
      client_before_send_ms: rpc.sent === undefined ? null : rpc.sent - began,
      transport_roundtrip_ms:
        rpc.received === undefined || rpc.sent === undefined
          ? null
          : rpc.received - rpc.sent,
      client_after_receive_ms:
        rpc.received === undefined ? null : began + elapsedMs - rpc.received,
      client_result_json_utf8_bytes: Buffer.byteLength(text),
      runner_encoding_ms: performance.now() - encodingBegan,
      producer_evidence_id: value?.evidence_id ?? null,
      is_error: reply.isError === true,
      progress,
    });
    await writeFile(resolve(values.output, `call-${calls.length}.json`), text);
    if (reply.isError) throw new ToolFailure(value);
    return value;
  } catch (error) {
    if (calls.at(-1)?.name !== name || calls.at(-1)?.arguments !== arguments_)
      calls.push({
        name,
        arguments: arguments_,
        elapsed_ms: performance.now() - began,
        failure: String(error),
        progress,
      });
    throw error;
  } finally {
    activeCall = undefined;
    for (const [id, pending] of pendingRpc)
      if (pending.rpc === rpc) pendingRpc.delete(id);
  }
};
const normalized = (value) => value.normalized_result;
const targetSha = (value) => value.subject?.digest.sha256;
const inventoryPaths = ["package.json", "main.js", "preload.js"];
const unique = (values) => [...new Set(values)].sort();
const inspectManagedTarget = async () => {
  const info = await call("inspect_managed_artifact", { path: values.path });
  const boundaries = await call("inspect_managed_native_boundaries", {
    path: values.path,
  });
  return {
    artifact_sha256: targetSha(info),
    artifact: normalized(info),
    boundaries: normalized(boundaries),
    evidence_ids: [info.evidence_id, boundaries.evidence_id],
  };
};

/** The same counts/export question for each pinned shipped WASM module. */
const inspectWasmTarget = async () => {
  let info;
  let recovery = null;
  const arguments_ = {
    path: values.path,
    glue_paths: [],
    candidate_paths: [],
  };
  const definition = catalogDefinitions.get("inspect_wasm_artifact");
  if (!definition) throw new Error("Missing advertised WASM definition");
  // Validate the real advertised dialect, including SDK-generated local refs.
  const supportsSummary = new Ajv2020({
    strict: false,
    validateFormats: false,
  }).compile(definition.inputSchema)({ ...arguments_, detail: "summary" });
  try {
    info = await call("inspect_wasm_artifact", {
      ...arguments_,
      ...(values.delivery === "summary" && supportsSummary
        ? { detail: "summary" }
        : {}),
    });
  } catch (error) {
    const reference =
      error instanceof ToolFailure &&
      error.value?.error?.code === "resource_constraint"
        ? error.value.error.details?.reported_limits?.evidence_reference
        : undefined;
    if (reference?.kind !== "retained-evidence") throw error;
    if (values.delivery === "summary") {
      info = await call("inspect_analysis_view", {
        source: reference,
        view: { kind: "summary" },
      });
      recovery =
        "existing completed producer reference read through typed WASM views";
    } else {
      const path = resolve(values.output, "retained-evidence.json");
      await call("export_evidence_bundle", { path });
      const bundle = JSON.parse(await readFile(path, "utf8"));
      const record = bundle.records.find(
        (row) => row.evidence_id === reference.evidence_id,
      );
      const { parseEvidence } = await import(
        pathToFileURL(
          resolve(values["runtime-root"], "dist/domain/evidence.js"),
        ).href
      );
      info = parseEvidence(record);
      recovery =
        "complete producer Evidence exported after an observed transport constraint";
    }
  }
  const n = normalized(info);
  if (n.kind === "summary") {
    const summary = n.summary;
    const exportsEvidence = await call("inspect_analysis_view", {
      source: { kind: "retained-evidence", evidence_id: n.parent_evidence_id },
      view: { kind: "wasm", facet: "exports", offset: 0, limit: 4 },
    });
    return {
      artifact_sha256: targetSha(info),
      validation: summary.validation,
      section_count: summary.available_counts.sections,
      import_count: summary.available_counts.imports,
      export_count: summary.available_counts.exports,
      exports_first4: normalized(exportsEvidence).item,
      wat_sha256: summary.wat.sha256,
      wat_code_units: summary.wat.code_units,
      tool_profile: summary.tool_profile,
      runtime_execution: summary.runtime_execution,
      network_fetch: summary.network_fetch,
      evidence_ids: [
        n.parent_evidence_id,
        info.evidence_id,
        exportsEvidence.evidence_id,
      ],
      source_evidence_id: n.parent_evidence_id,
      recovery,
    };
  }
  return {
    artifact_sha256: targetSha(info),
    validation: n.validation,
    section_count: n.sections.length,
    import_count: n.imports.length,
    export_count: n.exports.length,
    exports_first4: n.exports.slice(0, 4),
    wat_sha256: n.wat.sha256,
    wat_code_units: n.wat.text.length,
    tool_profile: n.tool_profile,
    runtime_execution: n.runtime_execution,
    network_fetch: n.network_fetch,
    evidence_ids: [info.evidence_id],
    source_evidence_id: info.evidence_id,
    recovery,
  };
};

const workflows = {
  "obsidian.asar": async () => {
    if (values["javascript-question"] === "selected") {
      const inspected = await call("analyze_javascript_application", {
        input_path: values.path,
        source_paths: ["package.json", "main.js"],
        detail: "summary",
      });
      const receipt = normalized(inspected);
      const parent = receipt.parent_evidence_id;
      const evidenceIds = [parent, inspected.evidence_id];
      const modules = [];
      let offset = 0;
      do {
        const page = await call("inspect_analysis_view", {
          source: { kind: "retained-evidence", evidence_id: parent },
          view: { kind: "page", collection: "modules", offset, limit: 64 },
        });
        evidenceIds.push(page.evidence_id);
        const view = normalized(page);
        for (const module of view.items.filter(
          (row) => row.path === "main.js",
        )) {
          const selected = await call("inspect_analysis_view", {
            source: { kind: "retained-evidence", evidence_id: parent },
            view: {
              kind: "item",
              collection: "modules",
              selector: { node_id: module.node_id },
            },
          });
          evidenceIds.push(selected.evidence_id);
          modules.push(normalized(selected).item);
        }
        if (view.coverage.exhausted) break;
        if (
          view.coverage.next_offset === null ||
          view.coverage.next_offset <= offset
        )
          throw new Error("Module page did not advance");
        offset = view.coverage.next_offset;
      } while (true);
      return {
        artifact_sha256: targetSha(inspected),
        ...receipt.summary,
        modules,
        limitations: receipt.limitations,
        evidence_ids: evidenceIds,
      };
    }
    await call("open_binary", { path: values.path });
    try {
      const inspected = await call(
        "inspect_artifact",
        values.delivery === "summary" ? { detail: "summary" } : {},
      );
      if (values.delivery === "summary") {
        const view = normalized(inspected);
        const summary = view.summary;
        if (!summary.source_complete || !summary.inspection)
          throw new Error(
            "Expected a complete inventory with inspection coverage",
          );
        const parent = view.parent_evidence_id;
        const selected = await call("inspect_analysis_view", {
          source: { kind: "retained-evidence", evidence_id: parent },
          view: {
            kind: "inventory",
            collection: "occurrences",
            logical_paths: inventoryPaths,
            offset: 0,
            limit: 64,
          },
        });
        const contradictions = [];
        let offset = 0;
        while (offset < summary.available_counts.integrity_contradictions) {
          const page = normalized(
            await call("inspect_analysis_view", {
              source: { kind: "retained-evidence", evidence_id: parent },
              view: {
                kind: "inventory",
                collection: "integrity_contradictions",
                offset,
                limit: 64,
              },
            }),
          );
          contradictions.push(...page.items);
          if (page.coverage.exhausted) break;
          if (
            page.coverage.next_offset === null ||
            page.coverage.next_offset <= offset
          )
            throw new Error("Inventory page did not advance");
          offset = page.coverage.next_offset;
        }
        return {
          artifact_sha256: targetSha(inspected),
          manifest: summary.manifest,
          source_complete: summary.source_complete,
          entry_kind_counts: summary.observed_entry_kind_counts,
          requested_paths: normalized(selected).items,
          inventory_evidence_ids: summary.inventory_evidence_ids,
          integrity_contradictions: contradictions,
          coverage: summary.inspection.coverage,
          unexplored_branches: summary.inspection.unexplored_branches,
          limitations: view.limitations,
          evidence_ids: [inspected.evidence_id, selected.evidence_id],
        };
      }
      const inspection = normalized(inspected);
      const inventory = inspection.substeps[0].evidence;
      const graph = normalized(inventory);
      const counts = { file: 0, directory: 0, symlink: 0, slice: 0 };
      for (const row of graph.occurrences) counts[row.entry_kind]++;
      const { parseArtifactInventoryEvidence } = await import(
        pathToFileURL(
          resolve(
            values["runtime-root"],
            "dist/domain/artifactInventoryEvidence.js",
          ),
        ).href
      );
      const checked = parseArtifactInventoryEvidence(inventory);
      return {
        artifact_sha256: targetSha(inspected),
        manifest: graph.manifest,
        source_complete: checked.inventory.complete,
        entry_kind_counts: counts,
        requested_paths: graph.occurrences.filter((row) =>
          inventoryPaths.includes(row.logical_path),
        ),
        inventory_evidence_ids: [inventory.evidence_id],
        integrity_contradictions: graph.integrity_contradictions,
        coverage: inspection.coverage,
        unexplored_branches: inspection.unexplored_branches,
        evidence_ids: [inspected.evidence_id, inventory.evidence_id],
        limitations: unique([
          ...inspected.limitations,
          ...inspection.limitations,
          ...inventory.limitations,
        ]),
      };
    } finally {
      await call("close_binary", {});
    }
  },
  "newpipe.apk": async () => {
    const pkg = await call("inspect_android_package", { path: values.path });
    const found = await call("search_android_classes", {
      path: values.path,
      query: "MainActivity",
    });
    const cls = await call("inspect_android_class", {
      path: values.path,
      class_name: "org.schabi.newpipe.MainActivity",
    });
    return {
      artifact_sha256: targetSha(pkg),
      package_name: normalized(pkg).package_name,
      version_name: normalized(pkg).version_name,
      version_code: normalized(pkg).version_code,
      matches: normalized(found).matches,
      coverage: normalized(found).coverage,
      onCreate: normalized(cls).methods.filter(
        (row) => row.name === "onCreate",
      ),
      evidence_ids: [pkg.evidence_id, found.evidence_id, cls.evidence_id],
    };
  },
  "sharex.dll": inspectManagedTarget,
  "sharex.helpers.dll": inspectManagedTarget,
  "openwrt.bin": async () => {
    const info = await call("inspect_firmware_regions", { path: values.path });
    return {
      artifact_sha256: targetSha(info),
      result: normalized(info),
      evidence_ids: [info.evidence_id],
    };
  },
  "sqlite.wasm": inspectWasmTarget,
  "vscode.tree-sitter.wasm": inspectWasmTarget,
  "vscode.tree-sitter-css.wasm": inspectWasmTarget,
  "weth.hex": async () => {
    const info = await call("inspect_evm_interface", {
      path: values.path,
      encoding: "hex",
    });
    const n = normalized(info);
    return {
      artifact_sha256: targetSha(info),
      artifact: n.artifact,
      bytecode: n.bytecode,
      functions: n.functions,
      discovery_completeness: n.discovery_completeness,
      runtime_execution: n.runtime_execution,
      limitations: n.limitations,
      evidence_ids: [info.evidence_id],
    };
  },
  ...Object.fromEntries(
    NATIVE_ARTIFACTS.map((artifact) => [
      artifact,
      async () =>
        measureNativeEntry({
          seed: await nativeEntrySeed(artifact, values.path),
          values,
          call,
          inputSha,
          ToolFailure,
        }),
    ]),
  ),
};

try {
  await client.connect(transport);
  connectedMs = performance.now() - started;
  // Observe the public Transport seam without replacing its codec or lifecycle.
  // These intervals separate SDK work from the transport/server roundtrip;
  // the roundtrip still includes server work, framing, IO and client parsing.
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    if (message.method === "tools/call" && activeCall !== undefined) {
      activeCall.rpc.sent = performance.now();
      pendingRpc.set(message.id, activeCall);
    }
    return send(message, options);
  };
  const receive = transport.onmessage;
  transport.onmessage = (message, extra) => {
    if ("result" in message || "error" in message) {
      const pending = pendingRpc.get(message.id);
      if (pending !== undefined) {
        pending.rpc.received = performance.now();
        pendingRpc.delete(message.id);
      }
    }
    receive?.(message, extra);
  };
  transport.stderr?.on("data", (chunk) => diagnostics.push(chunk.toString()));
  const catalogStarted = performance.now();
  const tools = [];
  let cursor;
  do {
    const page = await client.listTools(cursor === undefined ? {} : { cursor });
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  catalogMs = performance.now() - catalogStarted;
  for (const tool of tools) {
    if (catalogDefinitions.has(tool.name))
      throw new Error("Duplicate advertised tool name");
    catalogDefinitions.set(tool.name, tool);
  }
  catalogBytes = Buffer.byteLength(JSON.stringify(tools));
  catalogInputBytes = Buffer.byteLength(
    JSON.stringify(
      tools.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    ),
  );
  await writeFile(
    resolve(values.output, "catalog.json"),
    JSON.stringify(tools),
  );
  const workflow = workflows[values.artifact];
  if (!workflow) throw new Error("No pinned question for selected artifact");
  result = await workflow();
  if (result.artifact_sha256 !== inputSha)
    throw new Error("Producer target digest differs from selected bytes");
} catch (error) {
  failure = String(error);
} finally {
  try {
    await client.close();
  } catch (error) {
    failure = `${failure ?? ""} cleanup: ${String(error)}`;
  }
}
await writeFile(
  resolve(values.output, "diagnostics.log"),
  diagnostics.join(""),
);
const finalInputSha = await fileSha(values.path);
if (finalInputSha !== inputSha)
  failure = `${failure ?? ""} Selected artifact bytes changed during the workflow`;
if (result)
  await writeFile(
    resolve(values.output, "answer.json"),
    JSON.stringify(result),
  );
const report = {
  revision: values.revision,
  runtime_root: values["runtime-root"],
  artifact: values.artifact,
  artifact_sha256: inputSha,
  artifact_sha256_after: finalInputSha,
  delivery: values.delivery,
  sdk_schema_mode: values.schemas,
  native_question: NATIVE_ARTIFACTS.includes(values.artifact)
    ? values["native-question"]
    : null,
  javascript_question:
    values.artifact === "obsidian.asar" ? values["javascript-question"] : null,
  provider_settings_sha256: sha(JSON.stringify(selectedProviders)),
  provider_search_path_sha256: sha(
    selectedProviders.PATH ?? process.env.PATH ?? "",
  ),
  provider_environment_policy_sha256: sha(providerPolicyText),
  ...fingerprints,
  node_version: process.version,
  sdk_client_version: clientVersion,
  sdk_server_version: serverVersion,
  platform: process.platform,
  architecture: process.arch,
  connected_ms: connectedMs,
  catalog_ms: catalogMs,
  catalog_json_utf8_bytes: catalogBytes,
  catalog_input_definition_utf8_bytes: catalogInputBytes,
  elapsed_ms: performance.now() - started,
  calls,
  failure: failure ?? null,
  measurement_scope:
    "Public SDK Transport timestamps split client work from the transport/server roundtrip; parsed result JSON bytes are not raw wire bytes; runner encoding and writes are outside each call; engine-stage durations and independent producer truth are not inferred",
};
await writeFile(
  resolve(values.output, "summary.json"),
  JSON.stringify(report, null, 2),
);
process.stdout.write(
  JSON.stringify({
    artifact: values.artifact,
    delivery: values.delivery,
    elapsed_ms: report.elapsed_ms,
    failure: failure?.slice(0, 800) ?? null,
  }) + "\n",
);
if (failure) process.exitCode = 1;
