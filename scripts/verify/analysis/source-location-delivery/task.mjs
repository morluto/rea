import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

// Acquire artifactDir with docs/verification/source-map-budgets-2026-11-09/acquire.py.
// This driver runs the public compiled stdio workflow; no target application is executed.
const [rootArgument, configText, ...extra] = process.argv.slice(2);
assert(
  rootArgument && configText && extra.length === 0,
  "Usage: node task.mjs REPO_ROOT CONFIG_JSON",
);
const root = resolve(rootArgument);
const config = JSON.parse(configText);
assert(
  config && typeof config === "object" && !Array.isArray(config),
  "CONFIG_JSON must be an object",
);
const allowed = new Set([
  "artifactDir",
  "select",
  "detail",
  "resultPath",
  "exportPath",
  "maxResponseBytes",
]);
assert(
  Object.keys(config).every((key) => allowed.has(key)),
  "Unknown task configuration field",
);
assert(
  typeof config.artifactDir === "string" && isAbsolute(config.artifactDir),
  "artifactDir must be an absolute acquired-artifact directory",
);
assert(
  typeof config.select === "string" &&
    config.select.length > 0 &&
    config.select.length <= 256,
  "select must be a nonempty artifact filename selector, at most 256 characters",
);
assert(
  config.detail === "complete" || config.detail === "summary",
  "detail must be complete or summary",
);
for (const key of ["resultPath", "exportPath"]) {
  assert(
    config[key] === undefined ||
      (typeof config[key] === "string" && isAbsolute(config[key])),
    `${key} must be an absolute path when selected`,
  );
}
const MAX_LINE_BYTES = 32 * 1024 * 1024;
const RPC_TIMEOUT_MS = 45000;
assert(
  config.maxResponseBytes === undefined ||
    (Number.isSafeInteger(config.maxResponseBytes) &&
      config.maxResponseBytes >= 10 * 1024 * 1024 &&
      config.maxResponseBytes <= MAX_LINE_BYTES),
  "maxResponseBytes must fit the driver receive guard: integer 10..32 MiB",
);
const sources = JSON.parse(
  await readFile(join(config.artifactDir, "artifacts.json"), "utf8"),
);
assert(
  Array.isArray(sources),
  "artifacts.json must be the retained artifact list",
);
const selected = sources.filter(
  (source) =>
    typeof source.path === "string" && source.path.includes(config.select),
);
assert.equal(
  selected.length,
  1,
  "select must identify exactly one pinned artifact",
);
const source = selected[0];
assert(
  source.generated_script,
  "Selected point task requires an acquired generated script and analyst manifest",
);
const localFile = (path) => {
  assert(
    typeof path === "string" && !isAbsolute(path),
    "Artifact manifest paths must be relative",
  );
  const resolved = resolve(config.artifactDir, path);
  assert(
    !relative(config.artifactDir, resolved).startsWith(".." + sep) &&
      resolved !== resolve(config.artifactDir, ".."),
    "Artifact path must stay within artifactDir",
  );
  return resolved;
};
const mapPath = localFile(source.path);
const bytes = await readFile(mapPath);
assert.equal(bytes.length, source.bytes);
assert.equal(createHash("sha256").update(bytes).digest("hex"), source.sha256);
const artifact = JSON.parse(bytes.toString("utf8"));
const manifestPath = localFile(source.generated_script.path + ".manifest.json");
const child = spawn(process.execPath, [join(root, "scripts/rea.mjs"), "mcp"], {
  cwd: root,
  env: {
    ...process.env,
    REA_LOG_LEVEL: "silent",
    REA_MCP_TOOL_CATALOG_PROFILE: "full",
    REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
    REA_MCP_OUTPUT_SCHEMA_PROFILE: "full",
    ...(config.maxResponseBytes === undefined
      ? {}
      : { REA_MCP_MAX_RESPONSE_BYTES: String(config.maxResponseBytes) }),
    HOPPER_LAUNCHER_PATH: "/rea-unconfigured-deep-provider/hopper",
    GHIDRA_INSTALL_DIR: process.execPath,
  },
  stdio: ["pipe", "pipe", "pipe"],
});
let buffer = "",
  sequence = 0,
  stderr = "";
const pending = new Map(),
  calls = [];
const failPending = (error) => {
  for (const request of pending.values()) request.reject(error);
  pending.clear();
};
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr = (stderr + chunk).slice(-8192);
});
child.once("error", failPending);
child.once("exit", (code, signal) =>
  failPending(
    new Error(
      `MCP server exited (${String(code)}, ${String(signal)}): ${stderr}`,
    ),
  ),
);
child.stdin.on("error", failPending);
child.stdout.on("data", (chunk) => {
  try {
    buffer += chunk;
    assert(
      Buffer.byteLength(buffer) < MAX_LINE_BYTES,
      "32 MiB RPC line guard exceeded",
    );
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      const payload = JSON.parse(line),
        request = pending.get(payload.id);
      if (request) {
        pending.delete(payload.id);
        request.resolve({ payload, wireBytes: Buffer.byteLength(line) + 1 });
      }
    }
  } catch (error) {
    failPending(error);
  }
});
const rpc = async (method, params = {}) => {
  const request = { jsonrpc: "2.0", id: ++sequence, method, params },
    start = performance.now();
  const waiting = new Promise((resolveReply, rejectReply) => {
    const timer = setTimeout(() => {
      pending.delete(request.id);
      rejectReply(new Error(`RPC timeout ${method}: ${stderr}`));
    }, RPC_TIMEOUT_MS);
    pending.set(request.id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolveReply(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        rejectReply(error);
      },
    });
  });
  child.stdin.write(JSON.stringify(request) + "\n");
  const { payload, wireBytes } = await waiting;
  assert(!payload.error, JSON.stringify(payload.error));
  calls.push({
    request,
    reply: payload,
    wire_bytes: wireBytes,
    elapsed_ms: performance.now() - start,
  });
  return payload.result;
};
const errorOf = (r) =>
  r.isError
    ? JSON.parse(r.content.find((c) => c.type === "text").text).error
    : undefined;
const contentOf = (r) => {
  assert(!r.isError, JSON.stringify(errorOf(r)));
  return r.structuredContent;
};
try {
  await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "source-location-completed-task", version: "1" },
  });
  const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
  child.stdin.write(JSON.stringify(initialized) + "\n");
  calls.push({
    request: initialized,
    reply: null,
    wire_bytes: 0,
    elapsed_ms: 0,
  });
  const catalog = await rpc("tools/list");
  const definition = catalog.tools.find(
    (t) => t.name === "trace_web_source_location",
  );
  assert(definition);
  const args = {
    manifest_path: manifestPath,
    script_index: 0,
    source_map: { path: mapPath, url: source.url },
    generated_position: source.point,
    ...(config.detail === "summary" ? { detail: "summary" } : {}),
  };
  const initial = await rpc("tools/call", {
    name: "trace_web_source_location",
    arguments: args,
  });
  const error = errorOf(initial);
  let evidenceId,
    report,
    metadata = [],
    coverage;
  if (error) {
    assert.equal(error.code, "resource_constraint");
    const limits = error.details.reported_limits;
    evidenceId = limits.evidence_id;
    assert(evidenceId);
    const continuation = limits.continuation;
    assert(continuation, "new source-location continuation required");
    const first = contentOf(
      await rpc("tools/call", {
        name: continuation.name,
        arguments: continuation.arguments,
      }),
    ).normalized_result;
    report = first.source_location;
    metadata = [...first.items];
    coverage = first.coverage;
  } else {
    const evidence = contentOf(initial),
      result = evidence.normalized_result;
    if (config.detail === "summary") {
      evidenceId = result.parent_evidence_id;
      report = result.summary;
      metadata = [...report.matches];
      coverage = result.coverage;
    } else {
      assert.equal(
        createHash("sha256")
          .update(evidence.raw_result.source_map_text)
          .digest("hex"),
        source.sha256,
        "Complete initial MCP response must preserve exact raw map bytes",
      );
      evidenceId = evidence.evidence_id;
      report = result;
      metadata = [...report.matches];
      coverage = { exhausted: true };
    }
  }
  const reference = { kind: "retained-evidence", evidence_id: evidenceId };
  while (!coverage.exhausted) {
    const page = contentOf(
      await rpc("tools/call", {
        name: "inspect_analysis_view",
        arguments: {
          source: reference,
          view: {
            kind: "source-location",
            collection: "matches",
            offset: coverage.next_offset,
            limit: 64,
          },
        },
      }),
    ).normalized_result;
    metadata.push(...page.items);
    coverage = page.coverage;
  }
  assert.equal(report.source_map.sha256, source.sha256);
  assert.equal(metadata.length, source.expected_matches.length);
  const answer = [];
  for (let index = 0; index < metadata.length; index++) {
    const match = metadata[index],
      expected = source.expected_matches[index];
    assert.equal(
      match.state,
      expected.generated_only ? "generated-only" : "mapped",
    );
    if (match.state === "generated-only") {
      answer.push(match);
      continue;
    }
    assert.equal(match.source_index, expected.source_index);
    assert.equal(match.reported_source, expected.source);
    assert.equal(match.original_position.line, expected.original_line);
    assert.equal(match.original_position.column, expected.original_column);
    assert.equal(match.content.utf8_sha256, expected.content_sha256);
    const full = artifact.sourcesContent[expected.source_index],
      point = match.original_position.offset;
    assert(point !== null);
    let offset = Math.max(0, point - 256);
    if (
      offset > 0 &&
      full.charCodeAt(offset) >= 0xdc00 &&
      full.charCodeAt(offset) <= 0xdfff
    )
      offset--;
    let snippet;
    if ("text" in match.content) {
      assert.equal(
        createHash("sha256").update(match.content.text).digest("hex"),
        expected.content_sha256,
      );
      let end = Math.min(full.length, offset + 512);
      if (
        end < full.length &&
        full.charCodeAt(end - 1) >= 0xd800 &&
        full.charCodeAt(end - 1) <= 0xdbff
      )
        end--;
      snippet = match.content.text.slice(offset, end);
    } else {
      const text = contentOf(
        await rpc("tools/call", {
          name: "inspect_analysis_view",
          arguments: {
            source: reference,
            view: {
              kind: "source-location",
              collection: "source-text",
              match_index: match.match_index,
              offset,
              limit: 512,
            },
          },
        }),
      ).normalized_result;
      assert.equal(text.match.content.utf8_sha256, expected.content_sha256);
      snippet = text.item.text;
    }
    assert.equal(snippet, full.slice(offset, offset + snippet.length));
    assert(offset <= point && offset + snippet.length >= point);
    const { text: _text, ...identity } = match.content;
    answer.push({
      ...match,
      match_index: index,
      content: {
        ...identity,
        code_units: full.length,
        snippet: {
          offset_utf16: offset,
          length_utf16: snippet.length,
          text: snippet,
        },
      },
    });
  }
  let exported = false;
  if (config.exportPath) {
    const result = await rpc("tools/call", {
      name: "export_evidence_bundle",
      arguments: { path: config.exportPath },
    });
    assert(!result.isError);
    const bundle = JSON.parse(await readFile(config.exportPath, "utf8"));
    const parent = bundle.records.find((r) => r.evidence_id === evidenceId);
    assert(parent);
    assert.equal(
      createHash("sha256")
        .update(parent.raw_result.source_map_text)
        .digest("hex"),
      source.sha256,
    );
    exported = true;
  }
  const result = {
    config,
    evidence_id: evidenceId,
    source_map_sha256: source.sha256,
    lookup: report.lookup,
    matches: answer,
    export_verified: exported,
    calls: calls.map((c) => ({
      method: c.request.method,
      tool: c.request.params?.name,
      wire_bytes: c.wire_bytes,
      elapsed_ms: c.elapsed_ms,
      isError: c.reply?.result?.isError ?? false,
    })),
  };
  if (config.resultPath)
    await writeFile(
      config.resultPath,
      JSON.stringify({ config, definition, calls, answer: result }),
      { flag: "wx" },
    );
  console.log(JSON.stringify(result));
} finally {
  child.stdin.end();
  if (child.exitCode === null && child.signalCode === null)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(Error("MCP close timeout"));
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
}
