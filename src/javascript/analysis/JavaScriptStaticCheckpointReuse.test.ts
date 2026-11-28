import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { analyzeJavaScriptStaticSource } from "../../../tests/fixtures/javascriptStaticAnalysis.js";
import {
  javaScriptWorkerAdmissionSchema,
  javaScriptWorkerMessageSchema,
  javaScriptWorkerRequestSchema,
} from "./JavaScriptAnalysisWorkerProtocol.js";
import {
  encodeJavaScriptStaticCheckpoint,
  javaScriptStaticReuseKey,
  retainJavaScriptStaticCheckpoint,
  takeJavaScriptStaticCheckpoint,
} from "./JavaScriptAnalysisWorkerServer.js";

const declaring = `const { BrowserWindow } = require("electron");
new BrowserWindow({ webPreferences: { preload: require("path").join(__dirname, "preload.js") } });
module.exports = { ready: true };`;
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const request = (
  id: string,
  source: string,
  purpose: "analysis" | "preload-discovery",
  overrides: { path?: string; package_type?: "module" | "commonjs" } = {},
) =>
  javaScriptWorkerRequestSchema.parse({
    id,
    unknown_budget: purpose === "analysis" ? 1000 : 0,
    node_budget: purpose === "analysis" ? 1000 : 0,
    text_sha256: digest(source),
    file: {
      path: overrides.path ?? "main.js",
      sha256: digest(source),
      container_sha256: "a".repeat(64),
      bytes: Buffer.byteLength(source),
      inventory_artifact_id: "static-reuse-source",
      kind: "javascript",
      unpacked: false,
    },
    package_type: overrides.package_type ?? "commonjs",
    purpose,
    member_mutation_allowance: { alias_states: 524_288, source: "default" },
  });

it("retains a discovery checkpoint once for the exact request, including sources without call paths", () => {
  // A plain module records no Electron call paths.
  const plain = "module.exports = 1;";
  const facts = analyzeJavaScriptStaticSource(plain);
  const key = javaScriptStaticReuseKey(
    request(randomUUID(), plain, "analysis"),
  );
  retainJavaScriptStaticCheckpoint(key, facts);
  const retained = takeJavaScriptStaticCheckpoint(key);
  expect(retained?.text).toBe(encodeJavaScriptStaticCheckpoint(facts));
  expect(retained?.parse_status).toBe(facts.parse_status);
  expect(takeJavaScriptStaticCheckpoint(key)).toBeUndefined();

  // Request ids differ between passes; every result-affecting field is keyed.
  const base = request(randomUUID(), plain, "analysis");
  retainJavaScriptStaticCheckpoint(javaScriptStaticReuseKey(base), facts);
  for (const other of [
    request(randomUUID(), plain, "analysis", { path: "other.js" }),
    request(randomUUID(), `${plain}\n`, "analysis"),
  ])
    expect(
      takeJavaScriptStaticCheckpoint(javaScriptStaticReuseKey(other)),
    ).toBeUndefined();
  expect(
    takeJavaScriptStaticCheckpoint(
      javaScriptStaticReuseKey(request(randomUUID(), plain, "analysis")),
    )?.text,
  ).toBe(encodeJavaScriptStaticCheckpoint(facts));
});

it("drops a checkpoint the normal pass reads with another package type", () => {
  // Discovery reads an ESM package's preload as a module; the normal pass
  // reads the discovered preload as CommonJS and cannot reuse that checkpoint.
  const preload = "export const ready = true;";
  const facts = analyzeJavaScriptStaticSource(preload);
  const discovered = request(randomUUID(), preload, "preload-discovery", {
    path: "preload.js",
    package_type: "module",
  });
  const normal = request(randomUUID(), preload, "analysis", {
    path: "preload.js",
    package_type: "commonjs",
  });
  retainJavaScriptStaticCheckpoint(javaScriptStaticReuseKey(discovered), facts);
  expect(
    takeJavaScriptStaticCheckpoint(javaScriptStaticReuseKey(normal)),
  ).toBeUndefined();
  // The mismatched take released the entry rather than parking it forever.
  expect(
    takeJavaScriptStaticCheckpoint(javaScriptStaticReuseKey(discovered)),
  ).toBeUndefined();
});

/** Start the production worker entrypoint in its own private root. */
const startWorker = async () => {
  const root = await createTestTempDirectory("rea-js-static-reuse-");
  const entry = new URL(
    "../../composition/javascriptAnalysisWorkerProcess.ts",
    import.meta.url,
  ).href;
  const child = spawn(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(entry)});`,
    ],
    { cwd: root, stdio: ["pipe", "pipe", "pipe"] },
  );
  const closed = once(child, "close");
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const messages = lines[Symbol.asyncIterator]();
  const next = async () => {
    const line = await messages.next();
    if (line.done) throw new Error(`Worker output ended: ${stderr}`);
    return javaScriptWorkerMessageSchema.parse(JSON.parse(line.value));
  };
  expect(await next()).toMatchObject({ kind: "ready" });
  /** Run one job and return its static checkpoint text and terminal frame. */
  const job = async (purpose: "analysis" | "preload-discovery") => {
    const id = randomUUID();
    await writeFile(join(root, `${id}.source`), declaring, { flag: "wx" });
    child.stdin.write(`${JSON.stringify(request(id, declaring, purpose))}\n`);
    let checkpoint: string | undefined;
    for (;;) {
      const message = await next();
      if (message.kind === "static") {
        checkpoint = await readFile(join(root, `${id}.static.json`), "utf8");
        const admission = javaScriptWorkerAdmissionSchema.parse({
          id,
          semantic_result_budget_bytes: 1024 * 1024,
        });
        child.stdin.write(`${JSON.stringify(admission)}\n`);
      }
      if (message.kind === "complete" || message.kind === "failure")
        return { checkpoint, terminal: message };
    }
  };
  return {
    job,
    close: async () => {
      child.stdin.end();
      await closed;
      lines.close();
    },
  };
};

it("checkpoints the discovery-retained static facts byte-for-byte as a recomputation", async () => {
  const reusing = await startWorker();
  const fresh = await startWorker();
  try {
    const discovery = await reusing.job("preload-discovery");
    expect(discovery.terminal).toMatchObject({ kind: "complete" });
    // Discovery crosses only declarations.
    expect(
      JSON.parse(discovery.checkpoint!).electron.browser_windows,
    ).toHaveLength(1);
    const reused = await reusing.job("analysis");
    const recomputed = await fresh.job("analysis");
    expect(reused.terminal).toMatchObject({ kind: "complete" });
    expect(recomputed.terminal).toMatchObject({ kind: "complete" });
    expect(reused.checkpoint).toBe(recomputed.checkpoint);
    // The retained checkpoint is consumed; a repeat recomputes the same bytes.
    expect((await reusing.job("analysis")).checkpoint).toBe(
      recomputed.checkpoint,
    );
  } finally {
    await Promise.all([reusing.close(), fresh.close()]);
  }
});
