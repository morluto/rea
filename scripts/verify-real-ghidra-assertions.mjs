import { access } from "node:fs/promises";

import { parseBinaryTarget } from "../dist/application/BinaryTargetResolver.js";
import { SUPPORTED_GHIDRA_VERSION } from "../dist/ghidra/GhidraInstallation.js";
import { GHIDRA_SESSION_CAPABILITIES } from "../dist/ghidra/GhidraSessionValues.js";

export function assertLocalProcedureInfo(info, expectedAddress) {
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

export function assertProviderText(assembly, pseudocode, expectedAddress) {
  if (
    typeof assembly !== "string" ||
    !assembly.includes(`${expectedAddress}:`) ||
    assembly.trim().length === 0
  )
    throw new Error("Ghidra assembly rendering lost its address-bearing lines");
  if (typeof pseudocode !== "string" || pseudocode.trim().length === 0)
    throw new Error("Ghidra local function pseudocode is unavailable");
}

export function assertReferenceMetadata(observed) {
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

export function assertDossier(
  dossier,
  {
    address,
    expectedCallees = [],
    expectedString = null,
    requireAssembly = false,
    requireMultiBlock = false,
    requireJumpTable = false,
  },
) {
  assertDossierProcedure(dossier, address);
  assertNativeApiBoundary(dossier.native_api, requireJumpTable);
  assertDossierReferences(dossier);
  assertDossierCallees(dossier, expectedCallees);
  assertDossierStrings(dossier, expectedString);
  assertDossierAssembly(dossier, requireAssembly);
  assertDossierMultiBlock(dossier, requireMultiBlock);
}

export function assertDenseSwitchDossier(dossier, address) {
  assertDossier(dossier, {
    address,
    requireAssembly: true,
    requireMultiBlock: true,
  });
  const truncated = dossier.native_api.jump_tables.find(
    ({ mappings_truncated: mappingsTruncated }) => mappingsTruncated,
  );
  if (
    truncated === undefined ||
    truncated.mappings.length !== 32 ||
    truncated.mappings.some(
      ({ target_address: target, evidence }) =>
        !/^0x[0-9a-f]+$/u.test(target) ||
        !evidence.some(({ kind }) => kind === "jump-table"),
    )
  )
    throw new Error(
      `Ghidra dense jump-table truncation drifted: ${JSON.stringify(dossier.native_api.jump_tables)}`,
    );
}

function assertNativeApiBoundary(observed, requireJumpTable) {
  if (
    observed?.available !== true ||
    observed.provenance !== "ghidra-high-function" ||
    observed.parameters_truncated !== false ||
    observed.jump_tables_truncated !== false ||
    !["low", "medium", "high"].includes(observed.return_type?.confidence) ||
    !observed.return_type?.evidence?.some(
      ({ source }) => source === "ghidra-high-function",
    ) ||
    observed.pseudocode?.classification !== "decompiler-generated-non-source" ||
    observed.pseudocode.compilable !== false ||
    !observed.decompiler_artifacts?.includes("pointer-arithmetic")
  )
    throw new Error(
      `Ghidra native API boundary drifted: ${JSON.stringify(observed)}`,
    );
  if (!requireJumpTable) return;
  if (
    observed.jump_tables.length === 0 ||
    !observed.jump_tables.some(
      ({
        data_sources: sources,
        data_sources_truncated: sourcesTruncated,
        mappings,
        mappings_truncated: mappingsTruncated,
      }) =>
        !sourcesTruncated &&
        !mappingsTruncated &&
        sources.length > 0 &&
        sources.every(
          ({ address, evidence }) =>
            /^0x[0-9a-f]+$/u.test(address) &&
            evidence.some(({ kind }) => kind === "jump-table"),
        ) &&
        mappings.length > 0 &&
        mappings.every(
          ({ target_address: target, data_addresses: addresses, evidence }) =>
            /^0x[0-9a-f]+$/u.test(target) &&
            addresses.every((address) => /^0x[0-9a-f]+$/u.test(address)) &&
            evidence.some(({ kind }) => kind === "jump-table"),
        ),
    )
  )
    throw new Error(
      `Ghidra jump-table evidence drifted: ${JSON.stringify(observed.jump_tables)}`,
    );
}

function assertDossierProcedure(dossier, address) {
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
}

function assertDossierReferences(dossier) {
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
}

function assertDossierCallees(dossier, expectedCallees) {
  for (const expected of expectedCallees)
    if (!dossier.callees.items.some(({ address: value }) => value === expected))
      throw new Error(`Ghidra dossier missed callee ${expected}`);
}

function assertDossierStrings(dossier, expectedString) {
  if (
    expectedString !== null &&
    !dossier.referenced_strings.items.some(
      ({ value }) => value === expectedString,
    )
  )
    throw new Error(
      `Ghidra dossier missed referenced string ${expectedString}`,
    );
}

function assertDossierAssembly(dossier, requireAssembly) {
  if (
    requireAssembly &&
    (dossier.assembly.items.length === 0 || dossier.assembly.truncated)
  )
    throw new Error("Ghidra dossier assembly was unavailable or truncated");
}

function assertDossierMultiBlock(dossier, requireMultiBlock) {
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

export function dossierSummary(dossier) {
  return {
    address: dossier.procedure.address,
    pseudocode_chars: dossier.pseudocode.total_chars,
    instructions: dossier.instruction_scan.scanned,
    callees: dossier.callees.returned,
    outgoing_references: dossier.outgoing_references.returned,
    referenced_strings: dossier.referenced_strings.returned,
    basic_blocks: dossier.basic_blocks.returned,
    native_parameters:
      dossier.native_api.available === true
        ? dossier.native_api.parameters.length
        : null,
    jump_tables:
      dossier.native_api.available === true
        ? dossier.native_api.jump_tables.length
        : null,
  };
}

export async function assertSession(
  session,
  expectedDigest,
  expectedTargetSha256,
) {
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

export function assertRuntimeCoordinates(coordinates) {
  for (const name of ["runtime_root", "endpoint_path", "project_root"])
    if (typeof coordinates[name] !== "string")
      throw new Error(`Ghidra verifier did not observe ${name}`);
  if (typeof coordinates.process_id !== "number")
    throw new Error("Ghidra verifier did not observe its process ID");
}

export async function assertCleanup(coordinates) {
  for (const name of ["runtime_root", "endpoint_path", "project_root"]) {
    const path = coordinates[name];
    if (typeof path === "string" && (await exists(path)))
      throw new Error(`Ghidra cleanup left ${name}: ${path}`);
  }
  const pid = coordinates.process_id;
  if (typeof pid === "number" && processExists(pid))
    throw new Error(`Ghidra cleanup left process ${String(pid)}`);
}

export function assertDebugFixture(observed) {
  const expectedDocument = `target-${observed.target.sha256.slice(0, 12)}.bin`;
  if (
    !Array.isArray(observed.documents) ||
    observed.documents.length !== 1 ||
    observed.documents[0] !== expectedDocument
  )
    throw new Error(
      `Ghidra did not expose the digest-bound debug Program identity ${expectedDocument}: ${JSON.stringify(observed.documents)}`,
    );
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

export function assertStrippedFixture(observed) {
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

export function assertCrossFixture(observed) {
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

export async function assertMalformedFixture(path) {
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

export function findValue(items, expected) {
  return items.find((item) => symbolTail(item.value) === expected);
}

export function requireProcedure(items, expected) {
  const observed = findValue(items, expected);
  if (observed === undefined)
    throw new Error(`Ghidra procedure probe is unavailable: ${expected}`);
  return observed;
}

export function matchesSymbol(value, expected) {
  const tail = symbolTail(value);
  return tail === expected || tail === `_${expected}`;
}

export function symbolTail(value) {
  if (typeof value !== "string") return undefined;
  return value.split("::").at(-1);
}

export function summary(observed) {
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
