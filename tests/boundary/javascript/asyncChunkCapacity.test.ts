import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { javascriptAsyncChunkCapacity } from "../../fixtures/javascriptAsyncChunkCapacity.js";
import { analyzeJavaScriptStaticSource } from "../../fixtures/javascriptStaticAnalysis.js";

it("retains a wide factory's async keys before normalizing the registration", () => {
  // The forked boundary project preserves the default main-thread stack.
  const count = 130_000;
  const { source, factory } = javascriptAsyncChunkCapacity(count);
  const result = analyzeJavaScriptStaticSource(source);
  expect(result.parse_status).toBe("partial");
  expect(result.analysis_coverage?.syntax).toEqual({
    status: "complete",
    error_count: 0,
  });
  expect(result.bundler_registrations).toHaveLength(1);
  const registration = result.bundler_registrations[0];
  if (registration === undefined) throw new Error("Missing registration");
  const keys = new Set(registration.async_chunk_keys);
  expect(registration.async_chunk_keys).toHaveLength(count + 1);
  expect(keys.size).toBe(count + 1);
  expect(
    Array.from({ length: count }, (_, index) => String(index)).every((key) =>
      keys.has(key),
    ),
  ).toBe(true);
  expect(registration.async_chunk_keys[0]).toBe("0");
  expect(registration.async_chunk_keys.at(-1)).toBe("later");
  expect(registration.unknown_async_chunk_keys).toBe(1);
  expect(registration.modules).toHaveLength(2);
  const start = source.indexOf(factory);
  expect(registration.modules[0]).toMatchObject({
    module_key: "1",
    factory_require_name: "r",
    source_sha256: createHash("sha256").update(factory).digest("hex"),
    location: {
      start: { line: 1, column: start },
      end: { line: 1, column: start + factory.length },
    },
  });
}, 30_000);
