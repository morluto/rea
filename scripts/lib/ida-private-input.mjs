import assert from "node:assert/strict";

/**
 * Path of REA's private copy in a headless session's metadata. A database
 * records the executable it was built from, so its copy is the opened
 * database, as IdaSessionClient binds it.
 */
export function privateIdaInput(metadata, target, targetIsDatabase) {
  const path = targetIsDatabase ? metadata.idb_path : metadata.input_path;
  assert.equal(typeof path, "string");
  assert.notEqual(path, target);
  return path;
}
