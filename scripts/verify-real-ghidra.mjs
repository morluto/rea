#!/usr/bin/env node

import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { resolveGhidraAnalysisProfile } from "../dist/ghidra/GhidraAnalysisProfile.js";
import { GhidraClient } from "../dist/ghidra/GhidraClient.js";
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
const debugPath = join(fixtureRoot, "rea-ghidra-inventory-debug");
const strippedPath = join(fixtureRoot, "rea-ghidra-inventory-stripped");
const compiler = process.env.REA_CC ?? "cc";
try {
  const common = ["-O0", "-g", "-fno-inline", "-fno-pie", "-no-pie"];
  await exec(compiler, [...common, sourcePath, "-o", debugPath]);
  await exec(compiler, [...common, "-s", sourcePath, "-o", strippedPath]);

  const debug = await verifyTarget(debugPath, "debug");
  const stripped = await verifyTarget(strippedPath, "stripped");
  assertDebugFixture(debug);
  assertStrippedFixture(stripped);

  const customPath = process.env.GHIDRA_TARGET_PATH;
  const custom =
    customPath === undefined ? null : await verifyTarget(customPath, "custom");
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      provider: { id: "ghidra", version: SUPPORTED_GHIDRA_VERSION },
      fixture_source: sourcePath,
      fixtures: [summary(debug), summary(stripped)],
      custom_target: custom === null ? null : summary(custom),
      cleanup: "complete",
    })}\n`,
  );
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

async function verifyTarget(targetPath, variant) {
  const parsedTarget = await parseBinaryTarget(targetPath);
  if (!parsedTarget.ok) throw parsedTarget.error;
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
    }),
    targetPath: parsedTarget.value.path,
    providerVersion: SUPPORTED_GHIDRA_VERSION,
    profileDigest: profile.value.profile.digest,
  });

  let runtimeCoordinates;
  try {
    const started = await client.start();
    if (!started.ok) throw started.error;
    assertSession(started.value, profile.value.profile.digest);
    const pinged = await client.ping();
    if (!pinged.ok) throw pinged.error;
    assertSession(pinged.value, profile.value.profile.digest);
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
  const rejections = await verifyBridgeRejections(client);
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
  if (variant === "stripped")
    return { rejections, stringSearch, filteredStrings };

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
  return {
    rejections,
    addressName,
    resolvedAddress,
    containing,
    procedureSearch,
    stringSearch,
    filteredNames,
    filteredStrings,
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
  if (!called.ok) throw called.error;
  const parsed = parseGhidraInventoryResult(operation, called.value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
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

function symbolTail(value) {
  if (typeof value !== "string") return undefined;
  return value.split("::").at(-1);
}

function assertSession(session, expectedDigest) {
  if (
    session.provider.id !== "ghidra" ||
    session.provider.version !== SUPPORTED_GHIDRA_VERSION ||
    session.profile_digest !== expectedDigest ||
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
  for (const name of ["runtime_root", "socket_path", "project_root"])
    if (typeof coordinates[name] !== "string")
      throw new Error(`Ghidra verifier did not observe ${name}`);
  if (typeof coordinates.process_id !== "number")
    throw new Error("Ghidra verifier did not observe its process ID");
}

async function assertCleanup(coordinates) {
  for (const name of ["runtime_root", "socket_path", "project_root"]) {
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
