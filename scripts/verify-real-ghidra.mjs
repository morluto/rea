#!/usr/bin/env node

import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { resolveGhidraAnalysisProfile } from "../dist/ghidra/GhidraAnalysisProfile.js";
import { GhidraClient } from "../dist/ghidra/GhidraClient.js";
import { GHIDRA_DECOMPILE_REQUEST_TIMEOUT_MS } from "../dist/ghidra/GhidraDefaults.js";
import {
  parseGhidraFunctionInput,
  parseGhidraFunctionResult,
} from "../dist/ghidra/GhidraFunctionValues.js";
import { parseGhidraInventoryResult } from "../dist/ghidra/GhidraInventoryValues.js";
import {
  inspectGhidraInstallation,
  SUPPORTED_GHIDRA_VERSION,
} from "../dist/ghidra/GhidraInstallation.js";
import { GhidraHeadlessLauncher } from "../dist/ghidra/GhidraLauncher.js";
import { GHIDRA_PROVIDER_IDENTITY } from "../dist/ghidra/GhidraProvider.js";
import { GHIDRA_SESSION_CAPABILITIES } from "../dist/ghidra/GhidraSessionValues.js";
import { parseBinaryTarget } from "../dist/domain/binaryTarget.js";

const exec = promisify(execFile);
const installDir = process.env.GHIDRA_INSTALL_DIR;
if (installDir === undefined || !isAbsolute(installDir))
  throw new Error(
    "Set GHIDRA_INSTALL_DIR to the absolute root of an extracted Ghidra 12.1.2 release.",
  );
const installation = inspectGhidraInstallation({
  installDir,
  ...(process.env.JAVA_HOME === undefined
    ? {}
    : { javaHome: process.env.JAVA_HOME }),
});
if (!installation.available || installation.analyzeHeadlessPath === null)
  throw new Error(
    `Ghidra installation is unavailable: ${JSON.stringify(installation)}`,
  );
if (installation.providerVersion !== SUPPORTED_GHIDRA_VERSION)
  throw new Error("Ghidra provider version commitment drifted");

const fixtureRoot = await mkdtemp(join(tmpdir(), "rea-ghidra-fixtures-"));
const sourcePath = fileURLToPath(
  new URL("../tests/conformance/ghidra/inventory.c", import.meta.url),
);
const crossFormatSourcePath = fileURLToPath(
  new URL("../tests/conformance/ghidra/cross-format.c", import.meta.url),
);
const debugPath = join(fixtureRoot, "rea-ghidra-inventory-debug");
const strippedPath = join(fixtureRoot, "rea-ghidra-inventory-stripped");
const arm64ElfPath = join(fixtureRoot, "rea-ghidra-cross-arm64");
const peObjectPath = join(fixtureRoot, "rea-ghidra-cross-x86_64.obj");
const pePath = join(fixtureRoot, "rea-ghidra-cross-x86_64.exe");
const peImportLibraryPath = join(fixtureRoot, "rea-ghidra-cross-x86_64.lib");
const machObjectPath = join(fixtureRoot, "rea-ghidra-cross-x86_64.o");
const malformedPath = join(fixtureRoot, "rea-ghidra-malformed");
const compiler = process.env.REA_CC ?? "cc";
const clang = process.env.REA_CLANG ?? "clang";
const lldLink = process.env.REA_LLD_LINK ?? "lld-link";
try {
  const common = ["-O0", "-g", "-fno-inline", "-fno-pie", "-no-pie"];
  await exec(compiler, [...common, sourcePath, "-o", debugPath]);
  await exec(compiler, [...common, "-s", sourcePath, "-o", strippedPath]);
  await exec(clang, [
    "--target=aarch64-linux-gnu",
    "-O0",
    "-g",
    "-fno-inline",
    "-fno-pie",
    "-nostdlib",
    "-static",
    "-fuse-ld=lld",
    crossFormatSourcePath,
    "-Wl,-e,rea_cross_start",
    "-o",
    arm64ElfPath,
  ]);
  await exec(clang, [
    "--target=x86_64-pc-windows-msvc",
    "-O0",
    "-gcodeview",
    "-fno-inline",
    "-c",
    crossFormatSourcePath,
    "-o",
    peObjectPath,
  ]);
  await exec(lldLink, [
    "/entry:rea_cross_start",
    "/subsystem:console",
    "/nodefaultlib",
    "/export:rea_cross_entry",
    `/implib:${peImportLibraryPath}`,
    `/out:${pePath}`,
    peObjectPath,
  ]);
  await exec(clang, [
    "--target=x86_64-apple-darwin",
    "-O0",
    "-g",
    "-fno-inline",
    "-c",
    crossFormatSourcePath,
    "-o",
    machObjectPath,
  ]);
  await writeFile(malformedPath, Buffer.from("not-a-binary\n", "utf8"));

  const debug = await verifyTarget(debugPath, "debug", {
    format: "elf",
    architecture: "x86_64",
  });
  const stripped = await verifyTarget(strippedPath, "stripped", {
    format: "elf",
    architecture: "x86_64",
  });
  const arm64Elf = await verifyTarget(arm64ElfPath, "cross-arm64-elf", {
    format: "elf",
    architecture: "arm64",
  });
  const pe = await verifyTarget(pePath, "cross-x86_64-pe", {
    format: "pe",
    architecture: "x86_64",
  });
  const machObject = await verifyTarget(machObjectPath, "cross-x86_64-mach-o", {
    format: "mach-o",
    architecture: "x86_64",
  });
  assertDebugFixture(debug);
  assertStrippedFixture(stripped);
  for (const fixture of [arm64Elf, pe, machObject]) assertCrossFixture(fixture);
  await assertMalformedFixture(malformedPath);

  const customPath = process.env.GHIDRA_TARGET_PATH;
  const custom =
    customPath === undefined ? null : await verifyTarget(customPath, "custom");
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      provider: { id: "ghidra", version: SUPPORTED_GHIDRA_VERSION },
      fixture_sources: [sourcePath, crossFormatSourcePath],
      fixtures: [
        summary(debug),
        summary(stripped),
        summary(arm64Elf),
        summary(pe),
        summary(machObject),
      ],
      malformed_target: "rejected-before-provider-start",
      custom_target: custom === null ? null : summary(custom),
      cleanup: "complete",
    })}\n`,
  );
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

async function verifyTarget(targetPath, variant, expectedTarget = null) {
  const parsedTarget = await parseBinaryTarget(targetPath);
  if (!parsedTarget.ok) throw parsedTarget.error;
  if (
    expectedTarget !== null &&
    (parsedTarget.value.format !== expectedTarget.format ||
      parsedTarget.value.architecture !== expectedTarget.architecture)
  )
    throw new Error(
      `Fixture header classification drifted for ${variant}: ${JSON.stringify(parsedTarget.value)}`,
    );
  const profile = await resolveGhidraAnalysisProfile(
    parsedTarget.value,
    GHIDRA_PROVIDER_IDENTITY,
    installation,
  );
  if (!profile.ok || profile.value.profile === null)
    throw new Error("Ghidra analysis profile could not be committed");

  const client = new GhidraClient({
    launcher: new GhidraHeadlessLauncher({
      analyzeHeadlessPath: installation.analyzeHeadlessPath,
      ...(process.env.JAVA_HOME === undefined
        ? {}
        : { javaHome: process.env.JAVA_HOME }),
      bridgeScriptPath: fileURLToPath(
        new URL("../bridge/ghidra/ReaGhidraBridge.java", import.meta.url),
      ),
      platform: installation.platform,
    }),
    targetPath: parsedTarget.value.path,
    targetSha256: parsedTarget.value.sha256,
    providerVersion: SUPPORTED_GHIDRA_VERSION,
    profileDigest: profile.value.profile.digest,
    requestTimeoutMs: GHIDRA_DECOMPILE_REQUEST_TIMEOUT_MS,
  });

  let runtimeCoordinates;
  try {
    const started = await client.start();
    if (!started.ok) throw started.error;
    assertSession(
      started.value,
      profile.value.profile.digest,
      parsedTarget.value.sha256,
    );
    const pinged = await client.ping();
    if (!pinged.ok) throw pinged.error;
    assertSession(
      pinged.value,
      profile.value.profile.digest,
      parsedTarget.value.sha256,
    );
    runtimeCoordinates = client.diagnostics();
    assertRuntimeCoordinates(runtimeCoordinates);

    const documents = await call(client, "list_documents", {});
    const segments = await call(client, "list_segments", { document: null });
    const procedures = await allItems(client, "list_procedures", {
      document: null,
    });
    const names = await allItems(client, "list_names", {
      document: null,
      address: null,
    });
    const strings = await allItems(client, "list_strings", {
      document: null,
      address: null,
    });
    const probes =
      variant === "custom"
        ? null
        : await verifyInventoryOperations({
            client,
            variant,
            procedures,
            names,
            strings,
          });
    return {
      variant,
      target: parsedTarget.value,
      profile: profile.value.profile,
      session: pinged.value,
      documents,
      segments,
      procedures,
      names,
      strings,
      probes,
    };
  } finally {
    await client.close();
    if (runtimeCoordinates !== undefined)
      await assertCleanup(runtimeCoordinates);
  }
}

async function verifyInventoryOperations({
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
    rejections,
    addressName,
    resolvedAddress,
    containing,
    procedureSearch,
    stringSearch,
    filteredNames,
    filteredStrings,
    functionAnalysis,
  };
}

async function verifyDebugFunctionOperations(
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
    await Promise.all([
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
  assertLocalProcedureInfo(info, entry.address);
  assertProviderText(assembly, pseudocode, entry.address);
  for (const expected of [branch.address, indirect.address])
    if (!callees.includes(expected))
      throw new Error(`Ghidra call graph missed ${expected}`);
  if (!callers.includes(main.address) || entryXrefs.length === 0)
    throw new Error("Ghidra caller or xref relation missed main");
  const xrefOwners = [];
  const xrefOwnerFailures = [];
  for (const address of entryXrefs) {
    try {
      xrefOwners.push(
        await call(client, "resolve_containing_procedure", {
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
  if (
    !xrefOwners.some(
      (owner) => owner.found && owner.procedure.address === main.address,
    )
  )
    throw new Error(
      `Ghidra entry xrefs were not attributable to main: ${JSON.stringify({ entryXrefs, callers, xrefOwners, xrefOwnerFailures })}`,
    );
  assertReferenceMetadata(outgoing);
  const stringXrefs = await functionCall(client, "xrefs", {
    document: null,
    address: entryString.address,
  });
  if (stringXrefs.length === 0)
    throw new Error("Ghidra xrefs missed the entry string");

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

  const branchDossier = await functionCall(client, "analyze_function", {
    procedure: branch.address,
    limit: 500,
    max_pseudocode_chars: 100_000,
    max_instructions: 5_000,
  });
  assertDossier(branchDossier, {
    address: branch.address,
    expectedCallees: [leaf.address],
    requireMultiBlock: true,
  });

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
  if (
    indirectDossier.callees.items.some(
      ({ address }) => address === leaf.address,
    )
  )
    throw new Error(
      "Ghidra dossier falsely resolved a targetless callback as the fixture leaf",
    );
  if (!/\bcall\b/iu.test(indirectDossier.assembly.items.join("\n")))
    throw new Error("Ghidra indirect-call fixture lost its computed call site");

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

  return {
    entry: dossierSummary(entryDossier),
    branch: dossierSummary(branchDossier),
    indirect: dossierSummary(indirectDossier),
    cancellation: "cancelled-before-wire",
    timeout: "expired-before-wire",
    concurrency: "serialized-two-results",
  };
}

async function verifyStrippedFunctionOperations(client, entryString) {
  const stringXrefs = await functionCall(client, "xrefs", {
    document: null,
    address: entryString.address,
  });
  if (stringXrefs.length === 0)
    throw new Error("Ghidra stripped string xref probe is unavailable");
  const containing = await call(client, "resolve_containing_procedure", {
    document: null,
    address: stringXrefs[0],
  });
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

async function verifyCrossFormatOperations({
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

  let messageOwner = null;
  for (const address of messageXrefs) {
    const candidate = await call(client, "resolve_containing_procedure", {
      document: null,
      address,
    });
    if (candidate.found) {
      messageOwner = candidate;
      break;
    }
  }
  if (messageOwner === null)
    throw new Error(`${variant} did not resolve the string-owning function`);
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

  let branchAddress = null;
  for (const address of callees) {
    const candidate = await functionCall(client, "procedure_info", {
      document: null,
      procedure: address,
    });
    if (candidate.basicblock_count > 1) {
      branchAddress = address;
      break;
    }
  }
  if (branchAddress === null)
    throw new Error(`${variant} did not recover the multi-block callee`);
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

async function call(client, operation, parameters) {
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

async function functionCall(client, operation, parameters) {
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

function assertLocalProcedureInfo(info, expectedAddress) {
  if (
    info.entrypoint !== expectedAddress ||
    info.basicblock_count < 1 ||
    info.length < 1 ||
    typeof info.signature !== "string" ||
    info.signature.length === 0 ||
    info.classification.external ||
    info.classification.provenance !== "ghidra-function-manager"
  )
    throw new Error(
      `Ghidra procedure metadata drifted: ${JSON.stringify(info)}`,
    );
}

function assertProviderText(assembly, pseudocode, expectedAddress) {
  if (
    typeof assembly !== "string" ||
    !assembly.includes(`${expectedAddress}:`) ||
    assembly.trim().length === 0
  )
    throw new Error("Ghidra assembly rendering lost its address-bearing lines");
  if (typeof pseudocode !== "string" || pseudocode.trim().length === 0)
    throw new Error("Ghidra local function pseudocode is unavailable");
}

function assertReferenceMetadata(observed) {
  if (
    observed.instructions_scanned < 1 ||
    observed.instruction_scan_truncated ||
    observed.references.items.length === 0 ||
    !observed.references.items.every(
      ({ kind }) =>
        kind.available && kind.provenance === "ghidra-reference-manager",
    ) ||
    !observed.references.items.some(({ kind }) => kind.call) ||
    !observed.references.items.some(({ kind }) => kind.data)
  )
    throw new Error(
      `Ghidra typed reference metadata drifted: ${JSON.stringify(observed)}`,
    );
}

function assertDossier(
  dossier,
  {
    address,
    expectedCallees = [],
    expectedString = null,
    requireAssembly = false,
    requireMultiBlock = false,
  },
) {
  if (
    dossier.procedure.address !== address ||
    dossier.procedure.classification === null ||
    dossier.procedure.classification.provenance !== "ghidra-function-manager" ||
    dossier.procedure.classification.external ||
    dossier.pseudocode.text.trim().length === 0 ||
    dossier.pseudocode.returned_chars !== [...dossier.pseudocode.text].length ||
    dossier.instruction_scan.scanned < 1 ||
    dossier.instruction_scan.truncated ||
    !dossier.limitations.some((value) => /indirect|computed/u.test(value)) ||
    !dossier.limitations.some((value) => /Ghidra|Hopper|provider/u.test(value))
  )
    throw new Error(
      `Ghidra dossier truthfulness drifted: ${JSON.stringify(dossier)}`,
    );
  if (
    ![
      ...dossier.incoming_references.items,
      ...dossier.outgoing_references.items,
    ].every(
      ({ kind }) =>
        kind.available && kind.provenance === "ghidra-reference-manager",
    )
  )
    throw new Error("Ghidra dossier lost typed reference provenance");
  for (const expected of expectedCallees)
    if (!dossier.callees.items.some(({ address: value }) => value === expected))
      throw new Error(`Ghidra dossier missed callee ${expected}`);
  if (
    expectedString !== null &&
    !dossier.referenced_strings.items.some(
      ({ value }) => value === expectedString,
    )
  )
    throw new Error(
      `Ghidra dossier missed referenced string ${expectedString}`,
    );
  if (
    requireAssembly &&
    (dossier.assembly.items.length === 0 || dossier.assembly.truncated)
  )
    throw new Error("Ghidra dossier assembly was unavailable or truncated");
  if (
    requireMultiBlock &&
    (dossier.basic_blocks.items.length < 2 ||
      !dossier.basic_blocks.items.some(
        ({ successors }) => successors.length > 0,
      ))
  )
    throw new Error(
      "Ghidra dossier CFG missed the multi-block branch structure",
    );
}

function dossierSummary(dossier) {
  return {
    address: dossier.procedure.address,
    pseudocode_chars: dossier.pseudocode.total_chars,
    instructions: dossier.instruction_scan.scanned,
    callees: dossier.callees.returned,
    outgoing_references: dossier.outgoing_references.returned,
    referenced_strings: dossier.referenced_strings.returned,
    basic_blocks: dossier.basic_blocks.returned,
  };
}

async function allItems(client, operation, parameters) {
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

function assertDebugFixture(observed) {
  if (
    !Array.isArray(observed.documents) ||
    observed.documents.length !== 1 ||
    !observed.documents[0].includes("debug")
  )
    throw new Error("Ghidra did not expose exactly one debug Program identity");
  const entry = findValue(observed.procedures, "rea_ghidra_inventory_entry");
  const leaf = findValue(observed.procedures, "rea_ghidra_inventory_leaf");
  const external = observed.procedures.find(
    (item) => item.procedure.external && symbolTail(item.value) === "puts",
  );
  if (entry === undefined || leaf === undefined || external === undefined)
    throw new Error(
      "Ghidra procedure inventory missed local or external functions",
    );
  if (
    !observed.procedures.some(
      (item) => item.procedure.thunk && item.procedure.thunk_target !== null,
    )
  )
    throw new Error(
      "Ghidra procedure inventory did not distinguish a resolved thunk",
    );
  const entryName = findValue(observed.names, "rea_ghidra_inventory_entry");
  if (entryName === undefined || !entryName.symbol.primary)
    throw new Error("Ghidra symbol inventory missed the primary entry symbol");
  if (!observed.names.some((item) => item.symbol.external))
    throw new Error("Ghidra symbol inventory missed external symbols");
  assertStrings(observed.strings);
  assertSegments(observed.segments, observed.session.target.image_base);
}

function assertStrippedFixture(observed) {
  if (
    observed.procedures.length === 0 ||
    observed.names.length === 0 ||
    findValue(observed.procedures, "rea_ghidra_inventory_entry") !== undefined
  )
    throw new Error(
      "Stripped Ghidra fixture did not preserve stripped semantics",
    );
  assertStrings(observed.strings);
  assertSegments(observed.segments, observed.session.target.image_base);
}

function assertCrossFixture(observed) {
  if (
    observed.procedures.length === 0 ||
    observed.names.length === 0 ||
    observed.probes === null ||
    typeof observed.probes.entry !== "string" ||
    observed.probes.string_owner.referenced_strings < 1 ||
    observed.probes.branch.basic_blocks < 2
  )
    throw new Error(
      `Cross-format Ghidra semantics drifted: ${JSON.stringify(summary(observed))}`,
    );
  assertSegments(observed.segments, observed.session.target.image_base);
}

async function assertMalformedFixture(path) {
  const parsed = await parseBinaryTarget(path);
  if (parsed.ok || parsed.error._tag !== "BinaryTargetError")
    throw new Error(
      "Malformed executable was not rejected before provider start",
    );
}

function assertStrings(strings) {
  for (const expected of [
    "REA_GHIDRA_INVENTORY_ENTRY",
    "REA_GHIDRA_LEAF_VALUE",
  ]) {
    const item = strings.find((candidate) => candidate.value === expected);
    if (
      item === undefined ||
      item.value_truncated ||
      typeof item.string.encoding !== "string" ||
      item.string.byte_length < expected.length
    )
      throw new Error(`Ghidra string inventory missed ${expected}`);
  }
}

function assertSegments(segments, imageBase) {
  if (
    !Array.isArray(segments) ||
    segments.length === 0 ||
    !segments.some((item) => item.executable) ||
    !segments.some((item) => item.writable) ||
    !segments.every(
      (item) =>
        item.permissions.available === true &&
        item.permissions.source === "ghidra-memory-block" &&
        item.image_base === imageBase,
    )
  )
    throw new Error("Ghidra memory-block permissions or image base drifted");
}

function findValue(items, expected) {
  return items.find((item) => symbolTail(item.value) === expected);
}

function requireProcedure(items, expected) {
  const observed = findValue(items, expected);
  if (observed === undefined)
    throw new Error(`Ghidra procedure probe is unavailable: ${expected}`);
  return observed;
}

function matchesSymbol(value, expected) {
  const tail = symbolTail(value);
  return tail === expected || tail === `_${expected}`;
}

function symbolTail(value) {
  if (typeof value !== "string") return undefined;
  return value.split("::").at(-1);
}

function assertSession(session, expectedDigest, expectedTargetSha256) {
  if (
    session.provider.id !== "ghidra" ||
    session.provider.version !== SUPPORTED_GHIDRA_VERSION ||
    session.profile_digest !== expectedDigest ||
    session.target.sha256 !== expectedTargetSha256 ||
    session.read_only !== true ||
    session.analysis_complete !== true ||
    session.analysis_timed_out !== false ||
    session.capabilities.join(",") !== GHIDRA_SESSION_CAPABILITIES.join(",") ||
    !/^0x[0-9a-f]+$/u.test(session.target.image_base) ||
    session.target.default_address_space.length === 0
  )
    throw new Error(
      `Ghidra session commitment drifted: ${JSON.stringify(session)}`,
    );
}

function assertRuntimeCoordinates(coordinates) {
  for (const name of ["runtime_root", "endpoint_path", "project_root"])
    if (typeof coordinates[name] !== "string")
      throw new Error(`Ghidra verifier did not observe ${name}`);
  if (typeof coordinates.process_id !== "number")
    throw new Error("Ghidra verifier did not observe its process ID");
}

async function assertCleanup(coordinates) {
  for (const name of ["runtime_root", "endpoint_path", "project_root"]) {
    const path = coordinates[name];
    if (typeof path === "string" && (await exists(path)))
      throw new Error(`Ghidra cleanup left ${name}: ${path}`);
  }
  const pid = coordinates.process_id;
  if (typeof pid === "number" && processExists(pid))
    throw new Error(`Ghidra cleanup left process ${String(pid)}`);
}

function summary(observed) {
  return {
    variant: observed.variant,
    target_path: observed.target.path,
    target_sha256: observed.target.sha256,
    analysis_profile_digest: observed.profile.digest,
    language_id: observed.session.target.language_id,
    compiler_spec_id: observed.session.target.compiler_spec_id,
    image_base: observed.session.target.image_base,
    procedures: observed.procedures.length,
    names: observed.names.length,
    strings: observed.strings.length,
    memory_blocks: observed.segments.length,
  };
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return !(
      cause instanceof Error &&
      "code" in cause &&
      cause.code === "ESRCH"
    );
  }
}
