import assert from "node:assert/strict";
import { mcpTextValue } from "./mcp-verifier-results.mjs";

/** Exercise literal/regex search, Unicode identities and cache invalidation in Hopper. */
export async function verifyHopperSearch(call, invalid, procedure) {
  const address = procedure.address;
  const original = await call("address_name", { address });
  try {
    await verifySymbolNames(call, invalid, address);
    await verifySearchModes(call, address);
  } finally {
    await call("set_address_name", { address, name: original });
  }
  assert.deepEqual(
    await call("search_procedures", {
      pattern: original,
      mode: "literal",
      case_sensitive: true,
    }),
    [{ address, value: original }],
  );
  return {
    unicodeIdentity: true,
    literalMetacharacters: true,
    longValuePreserved: true,
    symbolUtf16LimitValidatedBeforeMutation: true,
    regexAndCaseModes: true,
    annotationCacheInvalidation: true,
    escapedUtf8AndByteStrings: true,
  };
}

async function verifySymbolNames(call, invalid, address) {
  const unicode = "REA_é_e\u0301_😀_Straße_ſ_İ";
  const extentNames = ["x".repeat(1024), "é".repeat(1024), "😀".repeat(512)];
  for (const name of ["REA_a.b[0]", unicode, ...extentNames]) {
    assert.equal(await call("set_address_name", { address, name }), true);
    assert.equal(await call("address_name", { address }), name);
    assert.deepEqual(await call("list_names", { address }), [
      { address, value: name },
    ]);
    assert.deepEqual(
      await call("search_procedures", {
        pattern: name,
        mode: "literal",
        case_sensitive: true,
      }),
      [{ address, value: name }],
    );
    assert.equal(await call("procedure_address", { procedure: name }), address);
  }
  assert.deepEqual(
    await call("search_procedures", { pattern: unicode, mode: "literal" }),
    [],
  );
  const other = (await call("list_procedures")).find(
    (item) => item.address !== address,
  );
  assert.ok(other);
  for (const name of ["x".repeat(1025), "é".repeat(1025), "😀".repeat(513)]) {
    await invalid(
      "set_address_name",
      { address, name },
      /UTF-16 code-unit symbol-name limit/u,
    );
    await invalid(
      "set_addresses_names",
      { names: { [other.address]: "must_not_apply", [address]: name } },
      /UTF-16 code-unit symbol-name limit/u,
    );
    assert.equal(await call("address_name", { address }), extentNames.at(-1));
    assert.equal(
      await call("address_name", { address: other.address }),
      other.value,
    );
  }
}

async function verifySearchModes(call, address) {
  await call("set_address_name", { address, name: "REA_Search_Upper" });
  assert.deepEqual(
    await call("search_procedures", {
      pattern: "rea_search_upper",
      mode: "literal",
      case_sensitive: false,
    }),
    [{ address, value: "REA_Search_Upper" }],
  );
  assert.deepEqual(
    await call("search_procedures", {
      pattern: "rea_search_upper",
      mode: "literal",
      case_sensitive: true,
    }),
    [],
  );
  assert.deepEqual(
    await call("search_procedures", {
      pattern: "^REA_Search_(?:Upper|Lower)$",
      mode: "regex",
      case_sensitive: true,
    }),
    [{ address, value: "REA_Search_Upper" }],
  );
  const strings = await call("list_strings");
  const long = "REA_LONG_LITERAL_" + "x".repeat(4096) + "needle";
  const longItem = strings.find((item) =>
    item.value.startsWith("REA_LONG_LITERAL_"),
  );
  assert.ok(longItem, "fixture omitted its real long literal");
  assert.ok(long.startsWith(longItem.value));
  assert.ok(longItem.provider_value.endsWith("…"));
  assert.equal(longItem.string.termination, "missing");
  const literalProcedure = (await call("list_procedures")).find((item) =>
    item.value.endsWith("rea_long_literal_procedure"),
  );
  assert.ok(literalProcedure);
  const dossier = await call("analyze_function", {
    procedure: literalProcedure.address,
  });
  const referenced = dossier.referenced_strings.find(
    (item) => item.address === longItem.address,
  );
  assert.ok(referenced, "function dossier omitted its long literal reference");
  const { source_address, ...stringRecord } = referenced;
  assert.ok(
    dossier.outgoing_references.some(
      (edge) =>
        edge.source_address === source_address &&
        edge.target_address === longItem.address,
    ),
  );
  assert.deepEqual(
    stringRecord,
    longItem,
    "function dossier discarded typed string provenance",
  );

  const fragments = strings.filter((item) => {
    const offset = BigInt(item.address) - BigInt(longItem.address);
    return offset >= 0n && offset < BigInt(Buffer.byteLength(long));
  });
  assert.equal(fragments.map((item) => item.value).join(""), long);
  for (const fragment of fragments) {
    assert.equal(
      Buffer.byteLength(fragment.value),
      fragment.string.byte_length -
        (fragment.string.termination === "missing" ? 0 : 1),
    );
    const bytes = await call("read_bytes", {
      address: fragment.address,
      length: fragment.string.byte_length,
    });
    const expected = Buffer.from(
      fragment.value + (fragment.string.termination === "missing" ? "" : "\0"),
    );
    assert.equal(bytes.bytes_hex, expected.toString("hex"));
  }
  assert.deepEqual(
    await call("search_strings", {
      pattern: "needle",
      mode: "literal",
      case_sensitive: true,
    }),
    [fragments.at(-1)],
  );
  const expected = strings.filter((item) =>
    /^REA_C_(?:ENTRY|LEAF)$/u.test(item.value),
  );
  assert.equal(expected.length, 2);
  assert.deepEqual(
    await call("search_strings", {
      pattern: "^REA_C_(?:ENTRY|LEAF)$",
      mode: "regex",
      case_sensitive: true,
    }),
    expected,
  );
  await verifyHopperStringObjects(call, [
    { value: "REA_UTF8_é_😀", encoding: "utf-8" },
    { value: 'REA_ESCAPED_"\\line\nend\t\r', encoding: "utf-8" },
    { value: "REA_LITERAL_BACKSLASH_\\n", encoding: "utf-8" },
    { value: "REA_LITERAL_…", encoding: "utf-8" },
    { value: "REA_LATIN1_ÿ", encoding: "latin-1" },
  ]);
}

/** Compare native string identities and values with the source fixture's bytes. */
export async function verifyHopperStringObjects(call, expectations) {
  const strings = await call("list_strings");
  for (const { value, encoding } of expectations) {
    const item = strings.find((candidate) => candidate.value === value);
    assert.ok(
      item,
      `Hopper omitted the decoded string ${JSON.stringify(value)}`,
    );
    assert.equal(item.string.encoding, encoding);
    assert.equal(item.string.encoding_status, "inferred");
    assert.equal(item.string.termination, "present_or_not_required");
    const expectedBytes = Buffer.from(
      value + "\0",
      encoding.replaceAll("-", ""),
    );
    assert.equal(item.string.byte_length, expectedBytes.length);
    const bytes = await call("read_bytes", {
      address: item.address,
      length: expectedBytes.length,
    });
    assert.equal(bytes.bytes_hex, expectedBytes.toString("hex"));
    assert.deepEqual(await call("list_strings", { address: item.address }), [
      item,
    ]);
    assert.deepEqual(
      await call("search_strings", {
        pattern: value,
        mode: "literal",
        case_sensitive: true,
      }),
      [item],
    );
  }
  assert.deepEqual(
    await call("search_strings", { pattern: "\\xC3\\xA9", mode: "literal" }),
    [],
  );
  return {
    sourceBytesVerified: true,
    inferredEncodingReported: true,
    displayEscapesExcludedFromMatching: true,
  };
}

/** A failed or cancelled pathological regex must leave the real Hopper API usable. */
export async function verifyHopperRegexIsolation(
  client,
  options,
  call,
  address,
) {
  const original = await call("address_name", { address });
  const pathological = "a".repeat(40) + "!";
  try {
    await call("set_address_name", { address, name: pathological });
    const reply = await client.callTool(
      {
        name: "search_procedures",
        arguments: { pattern: "(a+)+$", mode: "regex", case_sensitive: true },
      },
      options,
    );
    assert.equal(reply.isError, true);
    const { error } = JSON.parse(mcpTextValue(reply));
    assert.equal(error.code, "resource_constraint");
    assert.equal(error.details.operation, "search_procedures");
    assert.equal(error.details.resource, "cpu");
    assert.equal(await call("address_name", { address }), pathological);
    const controller = new AbortController();
    const pending = client.callTool(
      {
        name: "search_procedures",
        arguments: { pattern: "(a+)+$", mode: "regex", case_sensitive: true },
      },
      { ...options, signal: controller.signal },
    );
    const cancelled = pending.catch((cause) => cause);
    // The same small inventory has already completed once; leave the pathological
    // matching worker running before cancelling the second caller.
    await new Promise((resolve) => setTimeout(resolve, 750));
    controller.abort();
    await cancelled;
    assert.equal(await call("address_name", { address }), pathological);
    assert.deepEqual(
      await call("search_procedures", {
        pattern: pathological,
        mode: "literal",
        case_sensitive: true,
      }),
      [{ address, value: pathological }],
    );
  } finally {
    await call("set_address_name", { address, name: original });
  }
  return {
    regexDeadlinePreservesSession: true,
    regexCancellationPreservesSession: true,
  };
}
