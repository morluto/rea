import {
  parseGhidraFunctionInput,
  parseGhidraFunctionResult,
} from "../dist/ghidra/GhidraFunctionValues.js";

import {
  assertDossier,
  assertLocalProcedureInfo,
  assertProviderText,
  assertReferenceMetadata,
  dossierSummary,
  matchesSymbol,
  requireProcedure,
} from "./verify-real-ghidra-assertions.mjs";

export async function functionCall(client, operation, parameters) {
  const input = parseGhidraFunctionInput(operation, parameters);
  if (!input.ok) throw input.error;
  const called = await client.callTool(operation, input.value);
  if (!called.ok)
    throw new Error(
      `Ghidra ${operation} failed for ${JSON.stringify(input.value)}: ${called.error.message}`,
      { cause: called.error },
    );
  const parsed = parseGhidraFunctionResult(operation, called.value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

export async function verifyDebugFunctionOperations(
  client,
  { procedures, strings, entry },
) {
  const leaf = requireProcedure(procedures, "rea_ghidra_inventory_leaf");
  const branch = requireProcedure(procedures, "rea_ghidra_inventory_branch");
  const indirect = requireProcedure(
    procedures,
    "rea_ghidra_inventory_indirect",
  );
  const main = requireProcedure(procedures, "main");
  const entryString = strings.find(
    (item) => item.value === "REA_GHIDRA_INVENTORY_ENTRY",
  );
  if (entryString === undefined)
    throw new Error("Ghidra debug string function probe is unavailable");

  const [info, assembly, pseudocode, callees, callers, outgoing, entryXrefs] =
    await collectEntryFunctionData(client, entry);
  assertLocalProcedureInfo(info, entry.address);
  assertProviderText(assembly, pseudocode, entry.address);
  assertEntryCallGraph({ branch, indirect, main, callees, callers });
  const { xrefOwners, xrefOwnerFailures } = await resolveXrefOwners(
    client,
    entryXrefs,
  );
  assertEntryXrefAttribution({
    entryXrefs,
    callers,
    xrefOwners,
    xrefOwnerFailures,
    main,
  });
  assertReferenceMetadata(outgoing);
  await assertStringXrefs(client, entryString.address);

  const entryDossier = await analyzeEntryDossier(
    client,
    entry,
    branch,
    indirect,
  );
  const branchDossier = await analyzeBranchDossier(client, branch);
  const indirectDossier = await analyzeIndirectDossier(client, indirect);
  assertIndirectDossier(indirectDossier, leaf.address);

  const { cancellation, timeout } = await verifyRequestCancellationAndTimeout(
    client,
    entry,
  );
  const concurrent = await verifyConcurrentRequests(client, entry, leaf);

  return {
    entry: dossierSummary(entryDossier),
    branch: dossierSummary(branchDossier),
    indirect: dossierSummary(indirectDossier),
    cancellation,
    timeout,
    concurrency: concurrent,
  };
}

async function collectEntryFunctionData(client, entry) {
  return Promise.all([
    functionCall(client, "procedure_info", {
      document: null,
      procedure: entry.value,
    }),
    functionCall(client, "procedure_assembly", {
      document: null,
      procedure: entry.value,
    }),
    functionCall(client, "procedure_pseudo_code", {
      document: null,
      procedure: entry.value,
    }),
    functionCall(client, "procedure_callees", {
      document: null,
      procedure: entry.value,
    }),
    functionCall(client, "procedure_callers", {
      document: null,
      procedure: entry.value,
    }),
    functionCall(client, "procedure_references", {
      document: null,
      procedure: entry.value,
      direction: "outgoing",
    }),
    functionCall(client, "xrefs", {
      document: null,
      address: entry.address,
    }),
  ]);
}

function assertEntryCallGraph({ branch, indirect, main, callees, callers }) {
  for (const expected of [branch.address, indirect.address])
    if (!callees.includes(expected))
      throw new Error(`Ghidra call graph missed ${expected}`);
  if (!callers.includes(main.address))
    throw new Error("Ghidra caller or xref relation missed main");
}

async function resolveXrefOwners(client, entryXrefs) {
  const xrefOwners = [];
  const xrefOwnerFailures = [];
  for (const address of entryXrefs) {
    try {
      xrefOwners.push(
        await functionCall(client, "resolve_containing_procedure", {
          document: null,
          address,
        }),
      );
    } catch (cause) {
      xrefOwnerFailures.push({
        address,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
  return { xrefOwners, xrefOwnerFailures };
}

function assertEntryXrefAttribution({
  entryXrefs,
  callers,
  xrefOwners,
  xrefOwnerFailures,
  main,
}) {
  if (
    !xrefOwners.some(
      (owner) => owner.found && owner.procedure.address === main.address,
    )
  )
    throw new Error(
      `Ghidra entry xrefs were not attributable to main: ${JSON.stringify({ entryXrefs, callers, xrefOwners, xrefOwnerFailures })}`,
    );
}

async function assertStringXrefs(client, entryStringAddress) {
  const stringXrefs = await functionCall(client, "xrefs", {
    document: null,
    address: entryStringAddress,
  });
  if (stringXrefs.length === 0)
    throw new Error("Ghidra xrefs missed the entry string");
}

async function analyzeEntryDossier(client, entry, branch, indirect) {
  const entryDossier = await functionCall(client, "analyze_function", {
    procedure: entry.address,
    include_assembly: true,
    limit: 500,
    max_pseudocode_chars: 100_000,
    max_instructions: 5_000,
  });
  assertDossier(entryDossier, {
    address: entry.address,
    expectedCallees: [branch.address, indirect.address],
    expectedString: "REA_GHIDRA_INVENTORY_ENTRY",
    requireAssembly: true,
  });
  return entryDossier;
}

async function analyzeBranchDossier(client, branch) {
  const branchDossier = await functionCall(client, "analyze_function", {
    procedure: branch.address,
    limit: 500,
    max_pseudocode_chars: 100_000,
    max_instructions: 5_000,
  });
  assertDossier(branchDossier, {
    address: branch.address,
    requireMultiBlock: true,
  });
  return branchDossier;
}

async function analyzeIndirectDossier(client, indirect) {
  const indirectDossier = await functionCall(client, "analyze_function", {
    procedure: indirect.address,
    include_assembly: true,
    limit: 500,
    max_pseudocode_chars: 100_000,
    max_instructions: 5_000,
  });
  assertDossier(indirectDossier, {
    address: indirect.address,
    requireAssembly: true,
  });
  return indirectDossier;
}

function assertIndirectDossier(indirectDossier, leafAddress) {
  if (
    indirectDossier.callees.items.some(({ address }) => address === leafAddress)
  )
    throw new Error(
      "Ghidra dossier falsely resolved a targetless callback as the fixture leaf",
    );
  if (!/\bcall\b/iu.test(indirectDossier.assembly.items.join("\n")))
    throw new Error("Ghidra indirect-call fixture lost its computed call site");
}

async function verifyRequestCancellationAndTimeout(client, entry) {
  const aborted = new AbortController();
  aborted.abort();
  const cancelled = await client.callTool(
    "procedure_info",
    { document: null, procedure: entry.address },
    { signal: aborted.signal },
  );
  if (cancelled.ok || cancelled.error.kind !== "cancelled")
    throw new Error("Ghidra established-request cancellation drifted");

  const timedOut = await client.callTool(
    "procedure_info",
    { document: null, procedure: entry.address },
    { timeoutMs: 0 },
  );
  if (timedOut.ok || timedOut.error.kind !== "timeout")
    throw new Error("Ghidra established-request deadline drifted");

  return {
    cancellation: "cancelled-before-wire",
    timeout: "expired-before-wire",
  };
}

async function verifyConcurrentRequests(client, entry, leaf) {
  const concurrent = await Promise.all([
    functionCall(client, "procedure_info", {
      document: null,
      procedure: entry.address,
    }),
    functionCall(client, "xrefs", {
      document: null,
      address: leaf.address,
    }),
  ]);
  if (concurrent.length !== 2)
    throw new Error("Ghidra serial request queue lost a concurrent result");
  return "serialized-two-results";
}

export async function verifyStrippedFunctionOperations(client, entryString) {
  const stringXrefs = await functionCall(client, "xrefs", {
    document: null,
    address: entryString.address,
  });
  if (stringXrefs.length === 0)
    throw new Error("Ghidra stripped string xref probe is unavailable");
  const containing = await functionCall(
    client,
    "resolve_containing_procedure",
    {
      document: null,
      address: stringXrefs[0],
    },
  );
  if (!containing.found)
    throw new Error("Ghidra could not recover a stripped containing function");
  const procedure = containing.procedure;
  const pseudocode = await functionCall(client, "procedure_pseudo_code", {
    document: null,
    procedure: procedure.address,
  });
  if (typeof pseudocode !== "string" || pseudocode.trim().length === 0)
    throw new Error("Ghidra did not decompile the stripped function");
  const dossier = await functionCall(client, "analyze_function", {
    procedure: procedure.address,
    include_assembly: true,
    limit: 500,
    max_pseudocode_chars: 100_000,
    max_instructions: 5_000,
  });
  assertDossier(dossier, {
    address: procedure.address,
    expectedString: "REA_GHIDRA_INVENTORY_ENTRY",
    requireAssembly: true,
  });
  if (symbolTail(dossier.procedure.name) === "rea_ghidra_inventory_entry")
    throw new Error("Ghidra stripped dossier invented a source symbol");
  return dossierSummary(dossier);
}

export async function verifyCrossFormatOperations({
  client,
  variant,
  procedures,
  names,
  strings,
}) {
  const message = strings.find(
    (item) => item.value === "REA_GHIDRA_CROSS_FORMAT",
  );
  if (message === undefined)
    throw new Error(`${variant} string inventory missed the source oracle`);
  const entry =
    procedures.find((item) => matchesSymbol(item.value, "rea_cross_entry")) ??
    names.find((item) => matchesSymbol(item.value, "rea_cross_entry"));
  if (entry === undefined)
    throw new Error(`${variant} did not retain the exported entry symbol`);
  const entryAddress = entry.address;
  const info = await functionCall(client, "procedure_info", {
    document: null,
    procedure: entryAddress,
  });
  assertLocalProcedureInfo(info, entryAddress);
  const [pseudocode, assembly, callees, messageXrefs] = await Promise.all([
    functionCall(client, "procedure_pseudo_code", {
      document: null,
      procedure: entryAddress,
    }),
    functionCall(client, "procedure_assembly", {
      document: null,
      procedure: entryAddress,
    }),
    functionCall(client, "procedure_callees", {
      document: null,
      procedure: entryAddress,
    }),
    functionCall(client, "xrefs", {
      document: null,
      address: message.address,
    }),
  ]);
  assertProviderText(assembly, pseudocode, entryAddress);
  if (callees.length < 2)
    throw new Error(`${variant} call graph missed direct fixture calls`);
  if (messageXrefs.length === 0)
    throw new Error(`${variant} xrefs missed the fixture string`);

  const messageOwner = await findCrossStringOwner(client, messageXrefs);
  const stringDossier = await functionCall(client, "analyze_function", {
    procedure: messageOwner.procedure.address,
    limit: 500,
    max_pseudocode_chars: 100_000,
    max_instructions: 5_000,
  });
  assertDossier(stringDossier, {
    address: messageOwner.procedure.address,
    expectedString: "REA_GHIDRA_CROSS_FORMAT",
  });

  const branchAddress = await findCrossBranchAddress(client, variant, callees);
  const branchDossier = await functionCall(client, "analyze_function", {
    procedure: branchAddress,
    limit: 500,
    max_pseudocode_chars: 100_000,
    max_instructions: 5_000,
  });
  assertDossier(branchDossier, {
    address: branchAddress,
    requireMultiBlock: true,
  });
  return {
    entry: entryAddress,
    exported_symbol: entry.value,
    string_owner: dossierSummary(stringDossier),
    branch: dossierSummary(branchDossier),
  };
}

async function findCrossStringOwner(client, messageXrefs) {
  for (const address of messageXrefs) {
    const candidate = await functionCall(
      client,
      "resolve_containing_procedure",
      {
        document: null,
        address,
      },
    );
    if (candidate.found) return candidate;
  }
  throw new Error("Cross-format did not resolve the string-owning function");
}

async function findCrossBranchAddress(client, variant, callees) {
  for (const address of callees) {
    const candidate = await functionCall(client, "procedure_info", {
      document: null,
      procedure: address,
    });
    if (candidate.basicblock_count > 1) return address;
  }
  throw new Error(`${variant} did not recover the multi-block callee`);
}
