import { parseGhidraInventoryResult } from "../dist/ghidra/GhidraInventoryValues.js";

import { findValue, symbolTail } from "./verify-real-ghidra-assertions.mjs";
import {
  verifyCrossFormatOperations,
  verifyDebugFunctionOperations,
  verifyStrippedFunctionOperations,
} from "./verify-real-ghidra-function.mjs";

export async function call(client, operation, parameters) {
  const called = await client.callTool(operation, parameters);
  if (!called.ok)
    throw new Error(
      `Ghidra ${operation} failed for ${JSON.stringify(parameters)}: ${called.error.message}`,
      { cause: called.error },
    );
  const parsed = parseGhidraInventoryResult(operation, called.value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

export async function allItems(client, operation, parameters) {
  const items = [];
  let offset = 0;
  let total;
  while (true) {
    const page = await call(client, operation, {
      ...parameters,
      offset,
      limit: 500,
    });
    if (typeof page !== "object" || page === null || Array.isArray(page))
      throw new Error(`${operation} did not return a page`);
    items.push(...page.items);
    total ??= page.total;
    if (page.total !== total)
      throw new Error(`${operation} total changed during immutable paging`);
    if (!page.has_more) break;
    if (page.next_offset === null || page.next_offset <= offset)
      throw new Error(`${operation} returned a non-advancing page`);
    offset = page.next_offset;
  }
  if (items.length !== total)
    throw new Error(`${operation} pagination was not exhaustive`);
  return items;
}

async function expectRemoteFailure(client, operation, parameters, code) {
  const result = await client.callTool(operation, parameters);
  if (
    result.ok ||
    result.error.kind !== "remote" ||
    result.error.remoteCode !== code ||
    result.error.diagnostics.remote_code !== code
  )
    throw new Error(
      `Ghidra ${operation} rejection drifted: ${JSON.stringify(result)}`,
    );
  return { operation, code };
}

async function verifyBridgeRejections(client) {
  return {
    unknownDocument: await expectRemoteFailure(
      client,
      "list_segments",
      { document: "not-the-imported-program" },
      "not_found",
    ),
    malformedParameter: await expectRemoteFailure(
      client,
      "procedure_address",
      { document: null, procedure: 17 },
      "invalid_request",
    ),
    unboundedRegex: await expectRemoteFailure(
      client,
      "search_strings",
      {
        pattern: "a+",
        mode: "regex",
        case_sensitive: true,
        offset: 0,
        limit: 100,
        document: null,
      },
      "invalid_request",
    ),
    undeclaredMutation: await expectRemoteFailure(
      client,
      "set_comment",
      {},
      "method_unavailable",
    ),
  };
}

export async function verifyInventoryOperations({
  client,
  variant,
  procedures,
  names,
  strings,
}) {
  if (variant.startsWith("cross-"))
    return verifyCrossFormatOperations({
      client,
      variant,
      procedures,
      names,
      strings,
    });

  const rejections =
    variant === "debug" ? await verifyBridgeRejections(client) : null;
  const stringSearch = await call(client, "search_strings", {
    pattern: String.raw`^REA_GHIDRA_(?:INVENTORY_ENTRY|LEAF_VALUE)$`,
    mode: "regex",
    case_sensitive: true,
    offset: 0,
    limit: 100,
    document: null,
  });
  if (stringSearch.total !== 2 || stringSearch.items.length !== 2)
    throw new Error("Ghidra bounded regex string search drifted");
  const stringItem = strings.find(
    (item) => item.value === "REA_GHIDRA_INVENTORY_ENTRY",
  );
  if (stringItem === undefined)
    throw new Error("Ghidra string probe address is unavailable");
  const filteredStrings = await call(client, "list_strings", {
    document: null,
    address: stringItem.address,
    offset: 0,
    limit: 500,
  });
  if (
    filteredStrings.total !== 1 ||
    filteredStrings.items[0]?.address !== stringItem.address
  )
    throw new Error("Ghidra exact-address string filter drifted");

  if (variant === "stripped") {
    const functionAnalysis = await verifyStrippedFunctionOperations(
      client,
      stringItem,
    );
    return { rejections, stringSearch, filteredStrings, functionAnalysis };
  }

  const entry = findValue(procedures, "rea_ghidra_inventory_entry");
  if (entry === undefined)
    throw new Error("Ghidra entry procedure probe is unavailable");
  const debug = await verifyDebugInventoryCore({
    client,
    procedures,
    names,
    strings,
    entry,
  });
  return {
    rejections,
    stringSearch,
    filteredStrings,
    ...debug,
  };
}

async function verifyDebugInventoryCore({
  client,
  procedures,
  names,
  strings,
  entry,
}) {
  const addressName = await call(client, "address_name", {
    document: null,
    address: entry.address,
  });
  if (symbolTail(addressName) !== "rea_ghidra_inventory_entry")
    throw new Error("Ghidra primary address-name resolution drifted");
  const resolvedAddress = await call(client, "procedure_address", {
    document: null,
    procedure: entry.value,
  });
  if (resolvedAddress !== entry.address)
    throw new Error("Ghidra procedure-name resolution drifted");
  const interior = `0x${(BigInt(entry.address) + 1n).toString(16)}`;
  const containing = await call(client, "resolve_containing_procedure", {
    document: null,
    address: interior,
  });
  if (!containing.found || containing.procedure.address !== entry.address)
    throw new Error("Ghidra containing-procedure resolution drifted");
  const procedureSearch = await call(client, "search_procedures", {
    pattern: "rea_ghidra_inventory_",
    mode: "literal",
    case_sensitive: true,
    offset: 0,
    limit: 1,
    document: null,
  });
  if (
    procedureSearch.total < 2 ||
    procedureSearch.items.length !== 1 ||
    !procedureSearch.has_more ||
    procedureSearch.next_offset !== 1
  )
    throw new Error("Ghidra literal procedure-search pagination drifted");
  const name = names.find((item) => item.address === entry.address);
  if (name === undefined)
    throw new Error("Ghidra entry name probe is unavailable");
  const filteredNames = await call(client, "list_names", {
    document: null,
    address: entry.address,
    offset: 0,
    limit: 500,
  });
  if (
    filteredNames.total < 1 ||
    !filteredNames.items.some((item) => item.value === name.value)
  )
    throw new Error("Ghidra exact-address name filter drifted");
  const functionAnalysis = await verifyDebugFunctionOperations(client, {
    procedures,
    strings,
    entry,
  });
  return {
    addressName,
    resolvedAddress,
    containing,
    procedureSearch,
    filteredNames,
    functionAnalysis,
  };
}
