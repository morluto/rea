import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";

const cleanup = vi.hoisted(() => ({
  denied: false,
  onRemoval: undefined as (() => void) | undefined,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (
        String(args[0]).includes("rea-javascript-analysis-") &&
        String(args[0]).endsWith(".source")
      ) {
        cleanup.onRemoval?.();
        if (cleanup.denied)
          throw Object.assign(
            new Error("controlled transfer cleanup refusal"),
            { code: "EACCES" },
          );
      }
      return actual.rm(...args);
    },
  };
});
afterEach(() => {
  cleanup.denied = false;
  cleanup.onRemoval = undefined;
});
import { createJavaScriptSourceAnalysis } from "../../artifacts/javascript/JavaScriptSourceAnalysis.js";
import { spawnOwnedProviderProcess } from "../../process/ProviderProcess.js";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";

// Analyze inert source through the production worker and writer. Only the
// completed private transfer file or its descriptor is faulted before handoff.
it.each([
  "valid",
  "utf8",
  "length",
  "hash",
  "utf8-late-abort",
  "utf8-cleanup-retry",
] as const)(
  "authenticates the physical worker transfer at the source-analysis port: %s",
  { tags: ["long-running"] },
  async (mode) => {
    const controller = new AbortController();
    const cancellation = { reason: "cancel after physical transfer failure" };
    cleanup.denied = mode === "utf8-cleanup-retry";
    if (mode === "utf8-late-abort" || cleanup.denied)
      cleanup.onRemoval = () => controller.abort(cancellation);
    let root: string | undefined;
    const text = "export function observed() { return '�😀'; }";
    const file: JavaScriptArtifactFile = {
      path: "app.mjs",
      sha256: createHash("sha256").update(text).digest("hex"),
      container_sha256: "1".repeat(64),
      bytes: Buffer.byteLength(text),
      inventory_artifact_id: "transfer-source",
      kind: "javascript",
      unpacked: false,
      text: { included: true, value: text },
    };
    const workerUrl = new URL(
      "../../composition/javascriptAnalysisWorkerProcess.ts",
      import.meta.url,
    ).href;
    const bootstrap = `
      import { readFileSync, writeFileSync } from 'node:fs';
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk, ...rest) => {
        const frame = JSON.parse(String(chunk));
        if (frame.kind === 'complete' && frame.descriptor !== null) {
          const mode = ${JSON.stringify(mode)};
          if (mode.startsWith('utf8')) {
            const path = frame.id + '.records';
            const bytes = readFileSync(path);
            const offset = bytes.indexOf(Buffer.from('�'));
            if (offset < 0) throw new Error('Expected literal replacement character in real producer output');
            bytes.set([0xf0, 0x90, 0x80], offset);
            writeFileSync(path, bytes);
          }
          if (mode === 'length') frame.descriptor.bytes += 1;
          if (mode === 'hash') frame.descriptor.sha256 = '0'.repeat(64);
        }
        return write(JSON.stringify(frame) + '\\n', ...rest);
      };
      await import(${JSON.stringify(workerUrl)});
    `;
    const worker = await createJavaScriptSourceAnalysis(
      { heapMb: 192, timeoutMs: 30_000 },
      1,
      {
        launcher: (request) => {
          root = request.cwd;
          return spawnOwnedProviderProcess({
            ...request,
            arguments: [
              ...request.arguments.slice(0, -1),
              "--import",
              import.meta.resolve("tsx"),
              "--input-type=module",
              "-e",
              bootstrap,
            ],
          });
        },
      },
    );
    try {
      const result = await worker.analyze(
        file,
        { nodes: 100, unknowns: 100 },
        controller.signal,
      );
      if (mode === "valid") {
        if (!result.ok) throw result.error.error;
        expect(JSON.stringify(result.value.module)).toContain("�😀");
        expect(result.value.projection?.nodes.length).toBeGreaterThan(0);
      } else {
        if (result.ok) throw new Error(`Accepted corrupted ${mode} transfer`);
        const failure = result.error.error.cleanupPrimary ?? result.error.error;
        expect(failure._tag).toBe("AnalysisOutputError");
        if (mode.startsWith("utf8"))
          expect(failure.cause).toMatchObject({
            code: "ERR_ENCODING_INVALID_ENCODED_DATA",
          });
        expect(result.error.javascript?.parse_status).toBe("complete");
        expect(result.error.module).toBeNull();
        expect(result.error.projection).toBeNull();
        expect(result.error.error.cleanupIncomplete).toBe(cleanup.denied);
        if (cleanup.denied) {
          if (root === undefined)
            throw new Error("Worker root was not acquired");
          expect((await lstat(root)).isDirectory()).toBe(true);
        }
        if (mode === "utf8-late-abort" || cleanup.denied) {
          expect(failure.secondaryFailures).toHaveLength(1);
          expect(failure.secondaryFailures[0]).toMatchObject({
            _tag: "AnalysisCancelledError",
            cause: cancellation,
          });
          expect(failure.secondaryFailures[0]?.cause).toBe(cancellation);
        }
      }
    } finally {
      cleanup.denied = false;
      cleanup.onRemoval = undefined;
      await worker.close();
    }
    if (root === undefined) throw new Error("Worker root was not acquired");
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
