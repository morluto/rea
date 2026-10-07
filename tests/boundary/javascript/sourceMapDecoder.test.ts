import { fileURLToPath } from "node:url";
import type { SourceMapDecoderDependencies } from "../../../src/javascript/sourceMaps/SourceMapDecoder.js";
import { access } from "node:fs/promises";
import { expect, it } from "vitest";
import { SourceMapDecoder } from "../../../src/javascript/sourceMaps/SourceMapDecoder.js";
import { PrivateRuntimeRoot } from "../../../src/process/PrivateRuntimeRoot.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import { waitForProviderProcessReady } from "../../fixtures/providerProcess.js";
import {
  webSourceLocationArgs,
  webSourceLocationFixture,
} from "../../fixtures/webSourceLocation.js";

const realDecoder = (dependencies: SourceMapDecoderDependencies = {}) =>
  new SourceMapDecoder({
    ...dependencies,
    launcher:
      dependencies.launcher ??
      ((options) =>
        spawnOwnedProviderProcess({
          ...options,
          arguments: options.arguments.map((argument) =>
            argument.endsWith("/SourceMapCodecProcess.js") ||
            argument.endsWith("\\SourceMapCodecProcess.js")
              ? fileURLToPath(
                  new URL(
                    "../../../dist/javascript/sourceMaps/SourceMapCodecProcess.js",
                    import.meta.url,
                  ),
                )
              : argument,
          ),
        })),
  });

const fixture = webSourceLocationFixture();
const input = {
  text: fixture.sourceMap.text,
  url: fixture.sourceMap.url,
  path: fixture.sourceMap.file.path,
  position: webSourceLocationArgs.generated_position,
};

it("runs the real pinned codec with an independent heap and removes its private request directory", async () => {
  let path: string | undefined;
  const environment = {
    ...process.env,
    NODE_OPTIONS: "--require=/rea-file-that-does-not-exist",
  };
  const decoder = realDecoder({
    environment,
    createRuntime: async () => {
      const root = await PrivateRuntimeRoot.create();
      path = root.path;
      return root;
    },
  });
  const response = await decoder.trace(input);
  if (!response.ok) throw response.error;
  expect(response.value).toMatchObject({
    engine: { id: "jridgewell-trace-mapping", version: "0.3.31" },
    runtime: { id: "node-v8" },
    matches: [{ content: { text: "original" } }],
  });
  expect(response.value.runtime.v8_heap_limit_bytes).toBeLessThanOrEqual(
    256 * 1024 * 1024,
  );
  expect(environment.NODE_OPTIONS).toBe(
    "--require=/rea-file-that-does-not-exist",
  );
  if (path === undefined) throw new Error("runtime not acquired");
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
});
it.each([
  { text: "{", tag: "AnalysisInputError" },
  {
    text: JSON.stringify({
      version: 3,
      sections: [
        {
          offset: { line: 0, column: 0 },
          url: "https://app.test/external.map",
        },
      ],
    }),
    tag: "AnalysisCapabilityUnavailableError",
  },
  {
    text: JSON.stringify({
      version: 3,
      sections: [{ offset: { line: 1000000000, column: 0 }, map: {} }],
    }),
    tag: "ArtifactOperationError",
  },
])("preserves actual producer failures: $tag", async ({ text, tag }) => {
  const response = await realDecoder().trace({ ...input, text });
  if (response.ok) throw new Error("expected failed map");
  expect(response.error._tag).toBe(tag);
});
it("reports cleanup failure with the actual owning operation", async () => {
  const response = await realDecoder({
    createRuntime: async () => {
      const root = await PrivateRuntimeRoot.create();
      return {
        path: root.path,
        close: async () => {
          await root.close();
          throw new Error("observed cleanup failure");
        },
      };
    },
  }).trace(input);
  if (response.ok) throw new Error("expected cleanup failure");
  expect(response.error).toMatchObject({
    cleanupIncomplete: true,
    operation: "trace_web_source_location",
    diagnostics: { cleanup_failures: ["observed cleanup failure"] },
  });
});
it("cancels a real owned process and removes the runtime request", async () => {
  const controller = new AbortController();
  let path: string | undefined;
  const response = await realDecoder({
    createRuntime: async () => {
      const root = await PrivateRuntimeRoot.create();
      path = root.path;
      return root;
    },
    launcher: async (options) => {
      const child = await spawnOwnedProviderProcess({
        ...options,
        arguments: [
          "-e",
          'process.stdout.write("ready\\n"); setInterval(() => undefined, 1000)',
        ],
      });
      await waitForProviderProcessReady(child.process);
      setImmediate(() => controller.abort());
      return child;
    },
  }).trace(input, { signal: controller.signal });
  if (response.ok) throw new Error("expected cancellation");
  expect(response.error._tag).toBe("AnalysisCancelledError");
  if (path === undefined) throw new Error("runtime not acquired");
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
});
it("retains final diagnostic bytes for an actual failed codec process", async () => {
  const response = await realDecoder({
    launcher: (options) =>
      spawnOwnedProviderProcess({
        ...options,
        arguments: [
          "-e",
          'process.stderr.write("final diagnostic"); process.exitCode = 7',
        ],
      }),
  }).trace(input);
  if (response.ok) throw new Error("expected exit failure");
  expect(response.error).toMatchObject({
    diagnostics: { exit_code: 7, stderr: "final diagnostic" },
  });
});
it("reports complete evidence amplification as a resource failure before serializing an oversized reply", async () => {
  const text = JSON.stringify({
    version: 3,
    sources: ["large.ts"],
    sourcesContent: ["a".repeat(600000)],
    names: [],
    mappings: Array.from({ length: 60 }, () => "AAAA").join(","),
  });
  const response = await realDecoder().trace({ ...input, text });
  if (response.ok) throw new Error("expected complete-evidence budget failure");
  expect(response.error).toMatchObject({
    _tag: "ArtifactOperationError",
    reason: "limit",
    detail: expect.stringContaining("no partial"),
  });
});
it("rejects a malformed actual subprocess reply", async () => {
  const response = await realDecoder({
    launcher: (options) =>
      spawnOwnedProviderProcess({
        ...options,
        arguments: ["-e", 'process.stdout.write("not JSON")'],
      }),
  }).trace(input);
  if (response.ok) throw new Error("expected malformed reply");
  expect(response.error._tag).toBe("AnalysisOutputError");
});
it("removes the private request when launching the codec fails", async () => {
  let path: string | undefined;
  const response = await realDecoder({
    createRuntime: async () => {
      const root = await PrivateRuntimeRoot.create();
      path = root.path;
      return root;
    },
    launcher: () => Promise.reject(new Error("observed launch failure")),
  }).trace(input);
  if (response.ok) throw new Error("expected launch failure");
  expect(response.error).toMatchObject({
    diagnostics: { error_message: "observed launch failure" },
  });
  if (path === undefined) throw new Error("runtime not acquired");
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
});
