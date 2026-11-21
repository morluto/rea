import vm from "node:vm";
import {
  V8_CODE_CACHE_HEADER_BYTES,
  V8_CODE_CACHE_NARROW_HEADER_BYTES,
} from "../domain/v8/v8CodeCache.js";

/**
 * Generate a real V8 code cache instead of committing a version-pinned binary. Node
 * embeds V8, so the fixture producer is the same code path that writes a bytenode `.jsc`.
 */
export const v8CodeCacheFixture = (
  source = "function add(a, b) { return a + b; } add(1, 2);",
): Buffer =>
  new vm.Script(source, { produceCachedData: true }).createCachedData();

/** Build an offline reader fixture with the wide header's alignment word removed. */
export const withSyntheticNarrowHeader = (wide: Buffer): Buffer =>
  Buffer.concat([
    wide.subarray(0, V8_CODE_CACHE_NARROW_HEADER_BYTES),
    wide.subarray(V8_CODE_CACHE_HEADER_BYTES),
  ]);

/** `vm.compileFunction` sets the producer bit in the source-length word. */
export const v8FunctionCodeCacheFixture = (source = "return 1 + 2;"): Buffer =>
  vm.compileFunction(source, [], { produceCachedData: true }).cachedData ??
  Buffer.alloc(0);

/** Rewrite one header word of a real fixture to exercise a specific header value. */
export const withHeaderWord = (
  cache: Buffer,
  index: number,
  value: number,
): Buffer => {
  const copy = Buffer.from(cache);
  copy.writeUInt32LE(value >>> 0, index * 4);
  return copy;
};
