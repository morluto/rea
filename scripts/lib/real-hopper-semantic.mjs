import { requireFunctionDossierOracle } from "../../dist/application/RealHopperAssertions.js";

/** Verify named positive semantics from the source-owned C fixture. */
export async function verifyRealHopperFixture({
  client,
  options,
  document,
  oracle,
  normalizedResult,
}) {
  const main = await resolveFixtureProcedure(
    client,
    options,
    oracle.mainProcedure,
    normalizedResult,
  );
  const entry = await resolveFixtureProcedure(
    client,
    options,
    oracle.entryProcedure,
    normalizedResult,
  );
  const branch = await resolveFixtureProcedure(
    client,
    options,
    oracle.branchProcedure,
    normalizedResult,
  );
  const leaf = await resolveFixtureProcedure(
    client,
    options,
    oracle.leafProcedure,
    normalizedResult,
  );
  const comment = "REA real-Hopper conformance verifier";
  const commentSet = normalizedResult(
    await client.callTool(
      {
        name: "set_comment",
        arguments: { address: entry.address, comment, document },
      },
      options,
    ),
    "set_comment fixture marker",
  );
  if (commentSet !== true)
    throw new Error("Hopper did not read back the fixture comment marker");

  const entryDossier = requireFunctionDossierOracle(
    await analyzeFixtureProcedure(client, options, entry, normalizedResult),
    {
      procedure_address: entry.address,
      callee_address: branch.address,
      caller_address: main.address,
      referenced_string: oracle.entryString,
      comment,
      require_assembly: true,
    },
  );
  const branchDossier = requireFunctionDossierOracle(
    await analyzeFixtureProcedure(client, options, branch, normalizedResult),
    {
      procedure_address: branch.address,
      callee_address: leaf.address,
      caller_address: entry.address,
      require_cfg_successor: true,
      require_assembly: true,
    },
  );
  const leafDossier = requireFunctionDossierOracle(
    await analyzeFixtureProcedure(client, options, leaf, normalizedResult),
    {
      procedure_address: leaf.address,
      caller_address: branch.address,
      referenced_string: oracle.leafString,
      referenced_name: oracle.globalName,
      require_assembly: true,
    },
  );
  return {
    procedures: { main, entry, branch, leaf },
    entryComments: entryDossier.comments.returned,
    entryStrings: entryDossier.referenced_strings.returned,
    entryCallees: entryDossier.callees.returned,
    branchCallees: branchDossier.callees.returned,
    branchBlocks: branchDossier.basic_blocks.returned,
    leafStrings: leafDossier.referenced_strings.returned,
    leafNames: leafDossier.referenced_names.returned,
  };
}

/** Open one digest-bound fixture and prove every declared symbol and string. */
export async function verifyNamedFixture({
  client,
  options,
  target,
  expectations,
  normalizedResult,
}) {
  const opened = await client.callTool(
    { name: "open_binary", arguments: { path: target.path } },
    options,
  );
  if (opened?.isError === true)
    throw new Error(`open_binary failed for ${target.path}`);
  const symbols = [];
  for (const name of expectations.symbols ?? []) {
    const result = normalizedResult(
      await client.callTool(
        { name: "find_xrefs_to_name", arguments: { name } },
        options,
      ),
      `find_xrefs_to_name ${name}`,
    );
    if (
      result?.status !== "resolved" ||
      typeof result.name !== "string" ||
      stripSymbolPrefix(result.name) !== stripSymbolPrefix(name)
    )
      throw new Error(`Hopper did not resolve expected symbol ${name}`);
    symbols.push(result.name);
  }
  const strings = [];
  for (const value of expectations.strings ?? []) {
    const page = normalizedResult(
      await client.callTool(
        {
          name: "search_strings",
          arguments: {
            pattern: value,
            mode: "literal",
            case_sensitive: true,
            limit: 100,
          },
        },
        options,
      ),
      `search_strings ${value}`,
    );
    const matches = Array.isArray(page?.items)
      ? page.items.filter(
          (item) => item?.value === value && item.value_truncated === false,
        )
      : [];
    if (matches.length === 0)
      throw new Error(`Hopper did not resolve expected string ${value}`);
    strings.push(value);
  }
  return { path: target.path, sha256: target.sha256, symbols, strings };
}

/** Prove language-specific enhanced tools against their source-owned fixture. */
export async function verifyLanguageFixture({
  client,
  options,
  target,
  expectations,
  operations,
  semanticExpectations = {},
  normalizedResult,
}) {
  const inventory = await verifyNamedFixture({
    client,
    options,
    target,
    expectations,
    normalizedResult,
  });
  const semantics = {};
  for (const operation of operations) {
    const result = normalizedResult(
      await client.callTool({ name: operation, arguments: {} }, options),
      operation,
    );
    if (result === null || typeof result !== "object")
      throw new Error(`${operation} returned no semantic result`);
    const serialized = JSON.stringify(result);
    for (const expected of semanticExpectations[operation] ?? [])
      if (!serialized.includes(expected))
        throw new Error(`${operation} omitted expected semantic ${expected}`);
    semantics[operation] = result;
  }
  return { ...inventory, semantics };
}

/** Prove values intentionally absent from one version fixture. */
export async function verifyAbsentFixtureValues({
  client,
  options,
  target,
  symbols = [],
  strings = [],
  normalizedResult,
}) {
  const opened = await client.callTool(
    { name: "open_binary", arguments: { path: target.path } },
    options,
  );
  if (opened?.isError === true)
    throw new Error(`open_binary failed for ${target.path}`);
  for (const name of symbols) {
    const result = normalizedResult(
      await client.callTool(
        { name: "find_xrefs_to_name", arguments: { name } },
        options,
      ),
      `find_xrefs_to_name ${name}`,
    );
    if (result?.status !== "unresolved")
      throw new Error(`Hopper unexpectedly resolved symbol ${name}`);
  }
  for (const value of strings) {
    const page = normalizedResult(
      await client.callTool(
        {
          name: "search_strings",
          arguments: {
            pattern: value,
            mode: "literal",
            case_sensitive: true,
            limit: 100,
          },
        },
        options,
      ),
      `search_strings ${value}`,
    );
    if (
      Array.isArray(page?.items) &&
      page.items.some((item) => item?.value === value)
    )
      throw new Error(`Hopper unexpectedly resolved string ${value}`);
  }
}

const stripSymbolPrefix = (value) => value.replace(/^_+/u, "");

/** Reject malformed, unsafe, or error-level diagnostics from the MCP runtime. */
export function requireSafeDiagnostics(chunks) {
  const lines = chunks
    .join("")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (const line of lines) {
    let diagnostic;
    try {
      diagnostic = JSON.parse(line);
    } catch {
      throw new Error(`The MCP runtime emitted malformed stderr: ${line}`);
    }
    if (
      diagnostic === null ||
      typeof diagnostic !== "object" ||
      diagnostic.application !== "rea" ||
      typeof diagnostic.level !== "number" ||
      diagnostic.level >= 40
    )
      throw new Error(`The MCP runtime emitted unsafe stderr: ${line}`);
  }
  return lines.length;
}

/** Bind mutations to the active document rather than list ordering. */
export async function requireCurrentDocument(
  client,
  options,
  documents,
  normalizedResult,
) {
  const current = normalizedResult(
    await client.callTool({ name: "current_document", arguments: {} }, options),
    "current_document",
  );
  if (
    typeof current !== "string" ||
    current.length === 0 ||
    !documents.includes(current)
  )
    throw new Error("current_document was not present in list_documents");
  return current;
}

export async function resolveFixtureProcedure(
  client,
  options,
  expectedName,
  normalizedResult,
) {
  const page = normalizedResult(
    await client.callTool(
      {
        name: "search_procedures",
        arguments: {
          pattern: expectedName,
          mode: "literal",
          case_sensitive: true,
          limit: 100,
        },
      },
      options,
    ),
    `search_procedures ${expectedName}`,
  );
  const matches = Array.isArray(page?.items)
    ? page.items.filter(
        (item) =>
          typeof item?.value === "string" &&
          item.value_truncated === false &&
          item.value.replace(/^_+/u, "") === expectedName,
      )
    : [];
  if (
    matches.length !== 1 ||
    typeof matches[0]?.address !== "string" ||
    !/^0x[0-9a-f]+$/iu.test(matches[0].address)
  )
    throw new Error(
      `Expected exactly one Hopper procedure named ${expectedName}`,
    );
  return { address: matches[0].address, name: matches[0].value };
}

/** Request the assembly evidence required by the fixture oracle. */
export const analyzeFixtureProcedure = async (
  client,
  options,
  procedure,
  normalizedResult,
) =>
  normalizedResult(
    await client.callTool(
      {
        name: "analyze_function",
        arguments: { procedure: procedure.address, include_assembly: true },
      },
      options,
    ),
    `analyze_function ${procedure.name}`,
  );
