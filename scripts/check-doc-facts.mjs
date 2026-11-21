import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { syncCursorPluginSkill } from "./lib/cursor-plugin-bundle.mjs";
import { assertDocumentationFacts } from "./lib/docs-facts.mjs";
import { ensureGeneratedFile } from "./lib/generated-file.mjs";
import {
  createProductCatalog,
  serializeProductCatalog,
} from "./lib/product-catalog.mjs";

const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const arguments_ = new Set(process.argv.slice(2));
for (const argument of arguments_)
  if (argument !== "--built")
    throw new Error(`Unknown documentation check option: ${argument}`);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!arguments_.has("--built")) {
  await assertDocumentationFacts(root, await createProductCatalog(root));
} else {
  /** @type {Set<{ readonly stop: (signal: NodeJS.Signals) => void; readonly closed: Promise<void> }>} */
  const activeChildren = new Set();
  /** @type {NodeJS.Signals | undefined} */
  let cancelledSignal;

  /**
   * @param {import("node:child_process").ChildProcess} child
   * @param {NodeJS.Signals} signal
   */
  const signalChildGroup = (child, signal) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform !== "win32" && child.pid !== undefined)
        process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      /* child already exited */
    }
  };

  /** @param {NodeJS.Signals} signal */
  const onTerminationSignal = (signal) => {
    cancelledSignal ??= signal;
    for (const active of activeChildren) active.stop(signal);
  };
  const onSigint = () => onTerminationSignal("SIGINT");
  const onSigterm = () => onTerminationSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  /**
   * @param {string} script
   * @returns {Promise<{ readonly stdout: string; readonly stderr: string }>}
   */
  const runCheckScript = (script) =>
    new Promise((resolve, reject) => {
      if (cancelledSignal !== undefined) {
        reject(
          new Error(`Documentation check cancelled by ${cancelledSignal}`),
        );
        return;
      }
      const child = spawn(process.execPath, [join(root, script), "--check"], {
        cwd: root,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      /** @type {Buffer[]} */
      const stdoutChunks = [];
      /** @type {Buffer[]} */
      const stderrChunks = [];
      let outputBytes = 0;
      let overflowed = false;
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let escalationTimer;
      const stop = (/** @type {NodeJS.Signals} */ signal) => {
        signalChildGroup(child, signal);
        escalationTimer ??= setTimeout(
          () => signalChildGroup(child, "SIGKILL"),
          2_000,
        );
        escalationTimer.unref();
      };
      /** @type {() => void} */
      let markClosed = () => {};
      const closed = new Promise((resolveClosed) => {
        markClosed = resolveClosed;
      });
      const entry = { stop, closed };
      activeChildren.add(entry);
      if (cancelledSignal !== undefined) stop(cancelledSignal);

      /** @param {Buffer[]} chunks @param {Buffer} chunk */
      const collect = (chunks, chunk) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          if (!overflowed) {
            overflowed = true;
            stop("SIGTERM");
          }
          return;
        }
        chunks.push(chunk);
      };
      child.stdout.on("data", (chunk) => collect(stdoutChunks, chunk));
      child.stderr.on("data", (chunk) => collect(stderrChunks, chunk));
      child.once("error", (error) => {
        if (escalationTimer !== undefined) clearTimeout(escalationTimer);
        activeChildren.delete(entry);
        markClosed();
        reject(error);
      });
      child.once("close", (code, signal) => {
        if (escalationTimer !== undefined) clearTimeout(escalationTimer);
        activeChildren.delete(entry);
        markClosed();
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        if (!overflowed && code === 0 && signal === null) {
          resolve({ stdout, stderr });
          return;
        }
        const reason = overflowed
          ? `${script} exceeded ${String(MAX_OUTPUT_BYTES)} bytes of diagnostic output`
          : signal !== null
            ? `${script} terminated by ${signal}`
            : `${script} exited with code ${String(code)}`;
        reject(Object.assign(new Error(reason), { stdout, stderr }));
      });
    });

  /** @type {PromiseSettledResult<unknown>[]} */
  let settled = [];
  try {
    const catalogPromise = createProductCatalog(root);
    settled = await Promise.allSettled([
      catalogPromise.then((catalog) => assertDocumentationFacts(root, catalog)),
      catalogPromise.then(async (catalog) =>
        ensureGeneratedFile({
          path: join(root, "docs/public/product-catalog.json"),
          source: await serializeProductCatalog(catalog),
          check: true,
          generateCommand: "npm run docs:generate",
        }),
      ),
      syncCursorPluginSkill({ root, check: true }),
      runCheckScript("scripts/generate-package-metadata.mjs"),
      runCheckScript("scripts/generate-skill-metadata.mjs"),
      runCheckScript("scripts/generate-completion-ledger.mjs"),
      runCheckScript("scripts/generate-error-schema.mjs"),
      runCheckScript("scripts/generate-third-party-inventory.mjs"),
    ]);
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    for (const active of activeChildren) active.stop("SIGTERM");
    await Promise.allSettled([...activeChildren].map(({ closed }) => closed));
  }

  const failures = settled.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  for (const failure of failures) {
    if (failure && typeof failure === "object") {
      if (
        "stdout" in failure &&
        typeof failure.stdout === "string" &&
        failure.stdout
      )
        process.stderr.write(failure.stdout);
      if (
        "stderr" in failure &&
        typeof failure.stderr === "string" &&
        failure.stderr
      )
        process.stderr.write(failure.stderr);
    }
  }
  if (cancelledSignal !== undefined) {
    process.exitCode = cancelledSignal === "SIGINT" ? 130 : 143;
    throw new Error(`Documentation check cancelled by ${cancelledSignal}`);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      failures
        .map((cause) =>
          cause instanceof Error ? cause.message : String(cause),
        )
        .join("\n"),
    );
  }
}
