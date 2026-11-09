import assert from "node:assert/strict";

/** Compare public searches and composed traces with their provider inventory rows. */
export async function verifyGhidraSearchFacts(
  call,
  { strings, procedures, entryAddress },
) {
  const marker = strings.find(
    (row) => row.value === "REA_GHIDRA_INVENTORY_ENTRY",
  );
  const entry = procedures.find((row) => row.address === entryAddress);
  const external = procedures.find((row) => row.procedure.external);
  const thunk = procedures.find((row) => row.procedure.thunk);
  assert.ok(marker, "Missing source string fixture");
  assert.ok(entry, "Missing selected entry procedure");
  assert.ok(external, "Missing external procedure fixture");
  const cases = [
    { type: "string", operation: "search_strings", row: marker },
    ...[entry, external, ...(thunk === undefined ? [] : [thunk])].map(
      (row) => ({
        type: "procedure",
        operation: "search_procedures",
        row,
      }),
    ),
  ];
  for (const { type, operation, row } of cases) {
    const search = await call(operation, {
      pattern: row.value,
      mode: "literal",
      case_sensitive: true,
    });
    const match = search.find(
      (item) => item.address === row.address && item.value === row.value,
    );
    assert.deepEqual(
      match,
      row,
      `${operation} must preserve inventory facts for ${row.value}`,
    );
    const trace = await call("trace_feature", {
      query: row.value,
      case_sensitive: true,
    });
    const traced = trace.matches.find(
      (item) =>
        item.type === type &&
        item.address === row.address &&
        item.value === row.value,
    );
    assert.deepEqual(
      traced,
      { ...row, type },
      `trace_feature must preserve ${operation} facts for ${row.value}`,
    );
  }
  return { compared: cases.length, thunk_observed: thunk !== undefined };
}
