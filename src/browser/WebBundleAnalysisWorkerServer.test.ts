import { analyzeCapturedWebScript } from "../domain/webBundleAnalyzer.js";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it, onTestFinished } from "vitest";

import { createWebTextArtifact } from "../domain/webContentArtifact.js";
import type { IncludedScript } from "../domain/webBundleAnalyzerState.js";
import {
  webBundleWorkerMessageSchema,
  type WebBundleWorkerMessage,
  WEB_BUNDLE_WORKER_LIMITS,
} from "./WebBundleAnalysisWorkerProtocol.js";
import { JAVASCRIPT_MEMBER_MUTATION_WORK_LIMIT } from "../domain/javascript/javascriptSemanticWorkAllowance.js";
import { webBundleScriptAnalysisSchema } from "../domain/webBundleScriptAnalysis.js";

const makeScript = (text: string): IncludedScript => ({
  script_key: `scr_${createHash("sha256").update(text).digest("hex")}`,
  frame_id: "frame-1",
  url: "https://app.example.test/app.js",
  origin: "https://app.example.test",
  cdp_hash: null,
  length: Buffer.byteLength(text),
  is_module: false,
  language: "JavaScript",
  source_map_url: null,
  resource_reconciliation: {
    status: "unmatched",
    reason: "no_exact_sanitized_url",
  },
  source: {
    included: true,
    artifact: createWebTextArtifact(text, "application/javascript"),
  },
});

const sourceDescriptor = (script: IncludedScript) => {
  const bytes = Buffer.from(JSON.stringify(script));
  return {
    bytes,
    descriptor: {
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
};

const writeSource = async (
  root: string,
  id: string,
  bytes: Buffer,
): Promise<void> => {
  await writeFile(join(root, `${id}.source`), bytes, {
    flag: "wx",
    mode: 0o600,
  });
};

/** The parent always sends its accepted allowance with an analysis request. */
const DEFAULT_ALLOWANCE = { alias_states: 524_288, source: "default" } as const;

const startServer = async (
  root: string,
  analyzer = "analyzeCapturedWebScript",
): Promise<{
  readonly process: ChildProcessWithoutNullStreams;
  readonly next: () => Promise<WebBundleWorkerMessage>;
}> => {
  const loader = import.meta.resolve("tsx");
  const serverUrl = new URL(
    "./WebBundleAnalysisWorkerServer.ts",
    import.meta.url,
  ).href;
  const analyzerUrl = new URL("../domain/webBundleAnalyzer.ts", import.meta.url)
    .href;
  const workUrl = new URL(
    "../domain/javascript/javascriptSemanticWorkAllowance.ts",
    import.meta.url,
  ).href;
  const program = `
    const { serveWebBundleAnalysisWorker } = await import(${JSON.stringify(serverUrl)});
    const { analyzeCapturedWebScript } = await import(${JSON.stringify(analyzerUrl)});
    const { JavaScriptSemanticWorkMeter } = await import(${JSON.stringify(workUrl)});
    await serveWebBundleAnalysisWorker(${analyzer});
  `;
  const child = spawn(
    process.execPath,
    [
      "--max-old-space-size=128",
      "--import",
      loader,
      "--input-type=module",
      "-e",
      program,
    ],
    { cwd: root, stdio: ["pipe", "pipe", "pipe"] },
  );
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  return {
    process: child,
    next: async () => {
      const line = await iterator.next();
      if (line.done) {
        const stderr = await readStream(child.stderr);
        throw new Error(`Worker exited before a control frame: ${stderr}`);
      }
      const raw: unknown = JSON.parse(line.value);
      return webBundleWorkerMessageSchema.parse(raw);
    },
  };
};

const readStream = async (stream: NodeJS.ReadableStream): Promise<string> => {
  let output = "";
  for await (const chunk of stream) output += String(chunk);
  return output;
};

const writeInput = async (
  worker: ChildProcessWithoutNullStreams,
  frame: string | Buffer,
): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    worker.stdin.write(frame, (error) =>
      error === null || error === undefined ? resolve() : reject(error),
    );
  });
};

const send = async (
  worker: ChildProcessWithoutNullStreams,
  request: unknown,
): Promise<void> => writeInput(worker, `${JSON.stringify(request)}\n`);

const closeServer = async (
  worker: ChildProcessWithoutNullStreams,
): Promise<void> => {
  worker.stdin.end();
  if (worker.exitCode === null && worker.signalCode === null) {
    const exited = once(worker, "exit");
    const timeout = setTimeout(() => worker.kill("SIGKILL"), 2_000);
    await exited;
    clearTimeout(timeout);
  }
};

it("transfers reached semantic budgets and does not retain them for the next job", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-web-worker-precision-"));
  let worker: ChildProcessWithoutNullStreams | undefined;
  try {
    const server = await startServer(root);
    worker = server.process;
    expect(await server.next()).toMatchObject({ kind: "ready" });
    const script = makeScript(
      "const routes = {get path(){return '/a';}}; createBrowserRouter([{path:routes.path}]);",
    );
    const input = sourceDescriptor(script);
    for (const getterExpansions of [1, 512]) {
      const id = randomUUID();
      await writeSource(root, id, input.bytes);
      await send(worker, {
        kind: "analyze",
        id,
        member_mutation_allowance: DEFAULT_ALLOWANCE,
        semantic_precision: { getter_expansions: getterExpansions },
        source: input.descriptor,
        result_budget_bytes: WEB_BUNDLE_WORKER_LIMITS.resultBytes,
      });
      expect(await server.next()).toMatchObject({ kind: "phase", id });
      const completed = await server.next();
      expect(completed).toMatchObject({ kind: "complete", id });
      if (completed.kind !== "complete") throw new Error("Expected result");
      const bytes = await readFile(join(root, `${id}.result`));
      expect(completed.result).toEqual({
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      const result = webBundleScriptAnalysisSchema.parse(
        JSON.parse(bytes.toString("utf8")),
      );
      if (getterExpansions === 1)
        expect(result).toMatchObject({
          semantic_limits: [
            {
              limit: {
                parameter: "semantic_precision.getter_expansions",
                effective_value: 1,
              },
            },
          ],
        });
      else expect(result).not.toHaveProperty("semantic_limits");
    }
  } finally {
    if (worker !== undefined) await closeServer(worker);
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses with the allowance the parent sent and reports its limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-web-worker-work-"));
  let worker: ChildProcessWithoutNullStreams | undefined;
  onTestFinished(async () => {
    if (worker !== undefined) await closeServer(worker);
    await rm(root, { recursive: true, force: true });
  });
  const server = await startServer(
    root,
    "(_script, _precision, allowance) => new JavaScriptSemanticWorkMeter(allowance).charge(2)",
  );
  worker = server.process;
  expect(await server.next()).toMatchObject({ kind: "ready" });
  const input = sourceDescriptor(makeScript("fetch('/work');"));
  const id = randomUUID();
  await writeSource(root, id, input.bytes);
  await send(worker, {
    kind: "analyze",
    member_mutation_allowance: { alias_states: 1, source: "runtime" },
    id,
    source: input.descriptor,
    result_budget_bytes: WEB_BUNDLE_WORKER_LIMITS.resultBytes,
  });
  expect(await server.next()).toMatchObject({ kind: "phase", id });
  expect(await server.next()).toEqual({
    kind: "failure",
    id,
    reason: "resource",
    limits: { [JAVASCRIPT_MEMBER_MUTATION_WORK_LIMIT]: 1 },
    message: expect.stringMatching(/more than 1 alias states/u),
  });
});

it("applies the parent's literal ceiling and reports the omission", async () => {
  const server = await framingServer();
  const input = sourceDescriptor(
    makeScript("const routes = ['/api/one', '/api/two']; fetch('/api/kept');"),
  );
  const id = randomUUID();
  await writeSource(server.root, id, input.bytes);
  await send(server.process, {
    kind: "analyze",
    member_mutation_allowance: DEFAULT_ALLOWANCE,
    id,
    endpoint_literal_candidates: { maximum_count: 1, source: "runtime" },
    source: input.descriptor,
    result_budget_bytes: WEB_BUNDLE_WORKER_LIMITS.resultBytes,
  });
  expect(await server.next()).toMatchObject({ kind: "phase", id });
  expect(await server.next()).toMatchObject({ kind: "complete", id });
  const result = webBundleScriptAnalysisSchema.parse(
    JSON.parse(await readFile(join(server.root, `${id}.result`), "utf8")),
  );
  if (result.status !== "analyzed") throw new Error("Expected analyzed script");
  expect(
    result.inferences
      .filter(({ kind }) => kind === "endpoint_candidate")
      .map(({ value }) => value),
  ).toEqual(["/api/one"]);
  expect(result.endpoint_literal_candidates).toMatchObject({
    coverage: "partial",
    code: "web_bundle_endpoint_literal_candidates",
    admitted_count: 1,
    omitted_by_count: 1,
    omitted_by_result_budget: 0,
    ceiling: "adjustable",
    limit: {
      setting: "web.bundle_endpoint_literal_candidates",
      effective_value: 1,
      source: "runtime",
    },
  });
  // The ceiling bounds a literal inventory, not the request scanners.
  expect(result.observations.endpoints.map(({ value }) => value)).toEqual([
    "/api/kept",
  ]);
});

const framingServer = async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-web-worker-framing-"));
  let worker: ChildProcessWithoutNullStreams | undefined;
  onTestFinished(async () => {
    if (worker !== undefined) await closeServer(worker);
    await rm(root, { recursive: true, force: true });
  });
  const server = await startServer(root);
  worker = server.process;
  expect(await server.next()).toMatchObject({ kind: "ready" });
  return { root, ...server };
};

// Pipe writes do not fix read boundaries: BoundedControlLines.test.ts owns every
// split-chunk case deterministically. These worker tests prove the server wiring.
it("serves split and coalesced LF/CRLF requests as separate jobs", async () => {
  const server = await framingServer();
  const input = sourceDescriptor(makeScript("fetch('/framed');"));
  const ids = [randomUUID(), randomUUID()];
  const requests = ids.map((id) => ({
    kind: "analyze",
    member_mutation_allowance: DEFAULT_ALLOWANCE,
    id,
    source: input.descriptor,
    result_budget_bytes: WEB_BUNDLE_WORKER_LIMITS.resultBytes,
  }));
  for (const id of ids) await writeSource(server.root, id, input.bytes);
  const first = JSON.stringify(requests[0]);
  await writeInput(server.process, first.slice(0, 17));
  await writeInput(
    server.process,
    `${first.slice(17)}\n${JSON.stringify(requests[1])}\r\n`,
  );
  for (const id of ids) {
    expect(await server.next()).toMatchObject({ kind: "phase", id });
    expect(await server.next()).toMatchObject({ kind: "complete", id });
    expect(
      JSON.parse(await readFile(join(server.root, `${id}.result`), "utf8")),
    ).toMatchObject({ status: "analyzed" });
  }
});

it.each([
  ["multibyte", Buffer.from("é🙂")],
  ["replacement-decoded", Buffer.from([0xff])],
] as const)(
  "accepts an exact-budget %s JSON request written in split UTF-8 and CRLF writes",
  async (_name, text) => {
    const server = await framingServer();
    const input = sourceDescriptor(makeScript("fetch('/exact-budget');"));
    const id = randomUUID();
    await writeSource(server.root, id, input.bytes);
    const request = JSON.stringify({
      kind: "analyze",
      member_mutation_allowance: DEFAULT_ALLOWANCE,
      id,
      source: input.descriptor,
      result_budget_bytes: WEB_BUNDLE_WORKER_LIMITS.resultBytes,
    });
    // JSON.parse retains the final known key, so non-ASCII input exercises the
    // decoder while the request admitted by the named schema stays unchanged.
    const prefix = Buffer.from('{"kind":"');
    const json = Buffer.concat([
      prefix,
      text,
      Buffer.from(`",${request.slice(1)}`),
    ]);
    const decodedBytes = Buffer.byteLength(json.toString("utf8"));
    const frame = Buffer.concat([
      json,
      Buffer.alloc(WEB_BUNDLE_WORKER_LIMITS.protocolBytes - decodedBytes, 0x20),
    ]);
    expect(Buffer.byteLength(frame.toString("utf8"))).toBe(
      WEB_BUNDLE_WORKER_LIMITS.protocolBytes,
    );
    await writeInput(server.process, frame.subarray(0, prefix.length + 1));
    await writeInput(
      server.process,
      Buffer.concat([frame.subarray(prefix.length + 1), Buffer.from("\r")]),
    );
    await writeInput(server.process, "\n");
    expect(await server.next()).toMatchObject({ kind: "phase", id });
    expect(await server.next()).toMatchObject({ kind: "complete", id });
    expect(
      JSON.parse(await readFile(join(server.root, `${id}.result`), "utf8")),
    ).toMatchObject({ status: "analyzed" });
  },
);

it("rejects an oversized unterminated frame at EOF without starting analysis", async () => {
  const server = await framingServer();
  const input = sourceDescriptor(makeScript("fetch('/not-analyzed');"));
  const id = randomUUID();
  await writeSource(server.root, id, input.bytes);
  const request = JSON.stringify({
    kind: "analyze",
    member_mutation_allowance: DEFAULT_ALLOWANCE,
    id,
    source: input.descriptor,
    result_budget_bytes: WEB_BUNDLE_WORKER_LIMITS.resultBytes,
  });
  const frame = request.padEnd(WEB_BUNDLE_WORKER_LIMITS.protocolBytes + 1, " ");
  const exited = once(server.process, "exit");
  server.process.stdin.end(frame);
  await expect(server.next()).rejects.toThrow(
    "RangeError: Web bundle worker request exceeds its byte budget",
  );
  expect(await exited).toEqual([1, null]);
  await expect(
    readFile(join(server.root, `${id}.result`)),
  ).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("bounds and binds per-script worker jobs, then reuses one worker for the next script", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-web-worker-server-test-"));
  let worker: ChildProcessWithoutNullStreams | undefined;
  try {
    const server = await startServer(root);
    worker = server.process;
    const ready = await server.next();
    expect(ready).toMatchObject({ kind: "ready" });
    if (ready.kind !== "ready") throw new Error("Expected worker ready frame");
    expect(ready.heap_limit_bytes).not.toBeNull();
    expect(ready.heap_limit_bytes).toBeLessThan(512 * 1024 * 1024);
    expect(WEB_BUNDLE_WORKER_LIMITS).toMatchObject({
      protocolBytes: 64 * 1024,
      sourceBytes: 8 * 32 * 1024 * 1024,
      resultBytes: 8 * 1024 * 1024,
    });

    const script = makeScript("fetch('/users');");
    const input = sourceDescriptor(script);
    const missingId = randomUUID();
    await writeSource(root, randomUUID(), input.bytes);
    await send(worker, {
      kind: "analyze",
      member_mutation_allowance: DEFAULT_ALLOWANCE,
      id: missingId,
      source: input.descriptor,
      result_budget_bytes: WEB_BUNDLE_WORKER_LIMITS.resultBytes,
    });
    const missing = await server.next();
    expect(missing).toMatchObject({
      kind: "failure",
      id: missingId,
      reason: "io",
    });

    const digestId = randomUUID();
    await writeSource(root, digestId, input.bytes);
    await send(worker, {
      kind: "analyze",
      member_mutation_allowance: DEFAULT_ALLOWANCE,
      id: digestId,
      source: { ...input.descriptor, sha256: "0".repeat(64) },
      result_budget_bytes: WEB_BUNDLE_WORKER_LIMITS.resultBytes,
    });
    expect(await server.next()).toMatchObject({
      kind: "failure",
      id: digestId,
      reason: "input",
    });

    const budgetId = randomUUID();
    await writeSource(root, budgetId, input.bytes);
    await send(worker, {
      kind: "analyze",
      member_mutation_allowance: DEFAULT_ALLOWANCE,
      id: budgetId,
      source: input.descriptor,
      result_budget_bytes: 1,
    });
    expect(await server.next()).toMatchObject({
      kind: "phase",
      id: budgetId,
      phase: "analyze",
    });
    expect(await server.next()).toMatchObject({
      kind: "failure",
      id: budgetId,
      reason: "resource",
    });

    const nextScript = makeScript("fetch('/orders');");
    const nextInput = sourceDescriptor(nextScript);
    const nextId = randomUUID();
    await writeSource(root, nextId, nextInput.bytes);
    await send(worker, {
      kind: "analyze",
      member_mutation_allowance: DEFAULT_ALLOWANCE,
      id: nextId,
      source: nextInput.descriptor,
      result_budget_bytes: WEB_BUNDLE_WORKER_LIMITS.resultBytes,
    });
    expect(await server.next()).toMatchObject({
      kind: "phase",
      id: nextId,
      phase: "analyze",
    });
    const complete = await server.next();
    expect(complete).toMatchObject({ kind: "complete", id: nextId });
    if (complete.kind !== "complete")
      throw new Error("Expected result descriptor");
    const result = await readFile(join(root, `${nextId}.result`));
    expect(result.length).toBe(complete.result.bytes);
    expect(createHash("sha256").update(result).digest("hex")).toBe(
      complete.result.sha256,
    );
    expect(JSON.parse(result.toString("utf8"))).toMatchObject({
      status: "analyzed",
      script_key: nextScript.script_key,
    });

    // The legacy result fits, but the additional route facet does not. Actual
    // worker admission must retain the legacy facts and a partial route prefix.
    const routesScript = makeScript(
      "createBrowserRouter([{path:'/reports',children:[{path:'settings'},{path:'history'}]}]);",
    );
    const full = analyzeCapturedWebScript(routesScript);
    if (full.status !== "analyzed") throw new Error("Expected analysis");
    const { route_facts: _routeFacts, ...existing } = full;
    const offered =
      Buffer.byteLength(JSON.stringify(existing)) +
      Buffer.byteLength(',"route_facts":') +
      700;
    expect(Buffer.byteLength(JSON.stringify(full))).toBeGreaterThan(offered);
    const routesId = randomUUID(),
      routesInput = sourceDescriptor(routesScript);
    await writeSource(root, routesId, routesInput.bytes);
    await send(worker, {
      kind: "analyze",
      member_mutation_allowance: DEFAULT_ALLOWANCE,
      id: routesId,
      source: routesInput.descriptor,
      result_budget_bytes: offered,
    });
    expect(await server.next()).toMatchObject({ kind: "phase", id: routesId });
    const routesComplete = await server.next();
    if (routesComplete.kind !== "complete")
      throw new Error(JSON.stringify(routesComplete));
    const selectedBytes = await readFile(join(root, `${routesId}.result`));
    expect(selectedBytes.length).toBeLessThanOrEqual(offered);
    const selected = JSON.parse(selectedBytes.toString("utf8"));
    expect(selected.observations).toEqual(full.observations);
    expect(selected.route_facts.capacity).toMatchObject({
      kind: "result-bytes",
      limit_bytes: 700,
    });
    expect(selected.route_facts.candidates.length).toBeGreaterThan(0);
    expect(selected.route_facts.candidates.length).toBeLessThan(3);
  } finally {
    if (worker !== undefined) {
      await closeServer(worker);
    }
    await rm(root, { recursive: true, force: true });
  }
});
