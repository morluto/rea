import vm from "node:vm";

/**
 * Generate a real V8 code cache instead of committing a version-pinned binary. Node
 * embeds V8, so the fixture producer is the same code path that writes a bytenode `.jsc`.
 */
export const v8CodeCacheFixture = (
  source = "function add(a, b) { return a + b; } add(1, 2);",
): Buffer =>
  new vm.Script(source, { produceCachedData: true }).createCachedData();

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
