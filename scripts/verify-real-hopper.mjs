import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { TOOL_CONTRACTS } from "../dist/contracts/toolContracts.js";
import {
  firstProcedureAddress,
  requireAddressArray,
  requireFunctionDossier,
  requirePseudocode,
} from "../dist/application/RealHopperAssertions.js";
import { HOPPER_PROVIDER_IDENTITY } from "../dist/hopper/HopperProvider.js";
import { REA_WORKFLOW_PROVIDER } from "../dist/application/InvestigationProviders.js";
import { loadRealHopperFixtureTargets } from "./lib/real-hopper-fixture.mjs";
import {
  requireCurrentDocument,
  requireSafeDiagnostics,
  verifyRealHopperFixture,
} from "./lib/real-hopper-semantic.mjs";
import {
  mcpTextValue,
  requireEvidenceProvider,
  requireMcpResult,
  requireWorkflowEvidenceProvider,
} from "./lib/mcp-verifier-results.mjs";
import { openAndVerifyLargeFixture } from "./lib/real-hopper-pagination.mjs";
import { completeVerifierRun, createVerifierRun } from "./lib/verifier-run.mjs";
const execFileAsync = promisify(execFile);
const verifierRun = createVerifierRun();
const timeout = 180_000;
const parseServerArgs = (encoded) => {
  const parsed = JSON.parse(encoded);
  if (
    !Array.isArray(parsed) ||
    parsed.some((value) => typeof value !== "string")
  )
    throw new Error("REA_VERIFY_SERVER_ARGS_JSON must encode string arguments");
  return parsed;
};

const sessionsBefore = new Set(
  (await readdir("/tmp")).filter((name) => name.startsWith("rea-")),
);
const textValue = mcpTextValue;
const requireSuccessfulTool = requireMcpResult;

const requireHopperSelection = (status, expected) => {
  const candidates = status.analysis_provider_candidates;
  const hopper = Array.isArray(candidates)
    ? candidates.find(
        (candidate) => candidate?.provider?.id === HOPPER_PROVIDER_IDENTITY.id,
      )
    : undefined;
  if (
    hopper === undefined ||
    hopper.availability?.status !== "available" ||
    hopper.target_support?.status !== expected.targetSupport ||
    hopper.selected !== expected.selected
  ) {
    throw new Error("binary_session omitted truthful Hopper candidate status");
  }
  if (!expected.selected) {
    if (status.analysis_provider_binding !== null)
      throw new Error("Target-free status unexpectedly selected a provider");
    return null;
  }
  const binding = status.analysis_provider_binding;
  if (
    binding?.provider?.id !== HOPPER_PROVIDER_IDENTITY.id ||
    typeof binding.provider.version !== "string" ||
    binding.selection_source !== "auto-single-candidate" ||
    binding.analysis_profile?.provider?.id !== HOPPER_PROVIDER_IDENTITY.id ||
    binding.analysis_profile.provider.version !== binding.provider.version
  ) {
    throw new Error("binary_session omitted its concrete Hopper binding");
  }
  return binding;
};

const requireOverview = (value, operation) => {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.document !== "string" ||
    value.document.length === 0 ||
    !Number.isInteger(value.procedure_count) ||
    value.procedure_count < 1 ||
    !Number.isInteger(value.segment_count) ||
    value.segment_count < 1 ||
    !Array.isArray(value.segments)
  ) {
    throw new Error(`${operation} returned no analyzed binary overview`);
  }
  return value;
};

const requireTruthfulMemoryRegions = (segments) => {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error("list_segments returned no real memory regions");
  }
  const regions = segments.flatMap((segment) => [
    segment,
    ...(Array.isArray(segment.sections) ? segment.sections : []),
  ]);
  for (const region of regions) {
    for (const permission of ["readable", "writable", "executable"]) {
      if (![true, false, null].includes(region?.[permission])) {
        throw new Error(`list_segments omitted tri-state ${permission}`);
      }
    }
    if (
      region.provenance !== "hopper-public-python-api" ||
      region.permissions?.available !== false ||
      typeof region.permissions.reason !== "string"
    ) {
      throw new Error("list_segments omitted permission provenance");
    }
  }
};

const verifyRelationships = async (client, options, procedure) => {
  const related = {};
  for (const operation of ["procedure_callers", "procedure_callees"]) {
    related[operation] = requireAddressArray(
      requireSuccessfulTool(
        await client.callTool(
          { name: operation, arguments: { procedure } },
          options,
        ),
        operation,
      ),
      operation,
    );
  }
  related.xrefs = requireAddressArray(
    requireSuccessfulTool(
      await client.callTool(
        { name: "xrefs", arguments: { address: procedure } },
        options,
      ),
      "xrefs",
    ),
    "xrefs",
  );
  return related;
};

const verifyCurrentTarget = async (client, options) => {
  const procedures = requireSuccessfulTool(
    await client.callTool({ name: "list_procedures", arguments: {} }, options),
    "list_procedures",
  );
  const firstAddress = firstProcedureAddress(procedures);
  const containment = requireSuccessfulTool(
    await client.callTool(
      {
        name: "resolve_containing_procedure",
        arguments: { address: firstAddress },
      },
      options,
    ),
    "resolve_containing_procedure",
  );
  if (
    containment?.found !== true ||
    containment.procedure?.address !== firstAddress
  ) {
    throw new Error(
      "resolve_containing_procedure returned the wrong procedure",
    );
  }
  const references = requireSuccessfulTool(
    await client.callTool(
      {
        name: "procedure_references",
        arguments: {
          procedure: firstAddress,
          direction: "outgoing",
          limit: 10,
          max_instructions: 100,
        },
      },
      options,
    ),
    "procedure_references",
  );
  if (!Array.isArray(references?.references?.items)) {
    throw new Error("procedure_references returned an invalid bounded result");
  }
  const relationships = await verifyRelationships(
    client,
    options,
    firstAddress,
  );
  const boundedResult = requireSuccessfulTool(
    await client.callTool(
      {
        name: "batch_decompile",
        arguments: { addresses: [firstAddress] },
      },
      options,
    ),
    "batch_decompile",
  );
  if (
    boundedResult === null ||
    typeof boundedResult !== "object" ||
    Array.isArray(boundedResult) ||
    boundedResult.total !== 1 ||
    boundedResult.succeeded !== 1 ||
    boundedResult.failed !== 0 ||
    !Array.isArray(boundedResult.items) ||
    boundedResult.items.length !== 1 ||
    boundedResult.items[0]?.address !== firstAddress ||
    boundedResult.items[0]?.status !== "ok"
  ) {
    throw new Error("batch_decompile returned an invalid result");
  }
  const boundedPseudocode = requirePseudocode(
    boundedResult.items[0].pseudocode,
    "batch_decompile",
  );
  const dossier = requireFunctionDossier(
    requireSuccessfulTool(
      await client.callTool(
        {
          name: "analyze_function",
          arguments: { procedure: firstAddress },
        },
        options,
      ),
      "analyze_function",
    ),
    firstAddress,
  );
  return {
    procedure: dossier.procedure,
    procedureCount: procedures.total,
    boundedPseudocodeChars: boundedPseudocode.length,
    analyzedPseudocodeChars: [...dossier.pseudocode.text].length,
    callerCount: relationships.procedure_callers.length,
    calleeCount: relationships.procedure_callees.length,
    xrefCount: relationships.xrefs.length,
    outgoingReferenceCount: references.references.items.length,
  };
};

const fixtureManifestPath =
  process.env.REA_HOPPER_CONFORMANCE_MANIFEST_PATH ??
  "build/conformance/manifest.json";
const fixtureTargets = await loadRealHopperFixtureTargets(fixtureManifestPath);
const targetA = fixtureTargets.primary.path;
const targetB = fixtureTargets.secondary.path;
const largeTarget = fixtureTargets.large.path;
const targetHashA = fixtureTargets.primary.sha256;
const targetHashB = fixtureTargets.secondary.sha256;
const serverEnvironment = { ...process.env };
serverEnvironment.REA_ANALYSIS_PROVIDER = "auto";
delete serverEnvironment.HOPPER_TARGET_PATH;
delete serverEnvironment.HOPPER_SECOND_TARGET_PATH;
delete serverEnvironment.REA_VERIFY_SERVER_COMMAND;
delete serverEnvironment.REA_VERIFY_SERVER_ARGS_JSON;

const serverCommand = process.env.REA_VERIFY_SERVER_COMMAND ?? process.execPath;
const serverArgs = parseServerArgs(
  process.env.REA_VERIFY_SERVER_ARGS_JSON ?? '["dist/main.js"]',
);

const transport = new StdioClientTransport({
  command: serverCommand,
  args: serverArgs,
  cwd: process.cwd(),
  env: serverEnvironment,
  stderr: "pipe",
});
let stderrBytes = 0;
const stderrChunks = [];
transport.stderr?.on("data", (chunk) => {
  stderrBytes += chunk.length;
  if (stderrBytes <= 16_384) stderrChunks.push(chunk.toString("utf8"));
});
const client = new Client({ name: "real-hopper-verifier", version: "1.0.0" });
let summary;

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const expectedNames = TOOL_CONTRACTS.map(({ name }) => name).sort();
  const actualNames = listed.tools.map(({ name }) => name).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(
      "The real server tool inventory did not match its contracts",
    );
  }

  const options = { timeout };
  const fullSessionStatus = () =>
    client.callTool(
      { name: "binary_session", arguments: { detail: "full" } },
      options,
    );
  const initialSession = await fullSessionStatus();
  const initialStatus = requireMcpResult(initialSession, "binary_session");
  if (initialStatus.open !== false)
    throw new Error("The verifier did not start without a target");
  requireHopperSelection(initialStatus, {
    targetSupport: "unknown",
    selected: false,
  });
  const opened = await client.callTool(
    { name: "open_binary", arguments: { path: targetA } },
    options,
  );
  if (opened.isError === true) throw new Error(textValue(opened));
  const firstStatus = requireMcpResult(
    await fullSessionStatus(),
    "binary_session",
  );
  const providerBinding = requireHopperSelection(firstStatus, {
    targetSupport: "supported",
    selected: true,
  });
  const documents = await client.callTool(
    { name: "list_documents", arguments: {} },
    options,
  );
  const overview = await client.callTool(
    { name: "binary_overview", arguments: {} },
    options,
  );
  await Promise.all([
    requireEvidenceProvider(
      client,
      documents,
      "list_documents",
      HOPPER_PROVIDER_IDENTITY.id,
    ),
    requireWorkflowEvidenceProvider(client, overview, "binary_overview", {
      workflowProviderId: REA_WORKFLOW_PROVIDER.id,
      upstreamProviderId: HOPPER_PROVIDER_IDENTITY.id,
    }),
  ]);
  const segments = await client.callTool(
    { name: "list_segments", arguments: {} },
    options,
  );
  requireTruthfulMemoryRegions(
    requireSuccessfulTool(segments, "list_segments"),
  );
  const firstDocuments = requireSuccessfulTool(documents, "list_documents");
  if (
    !Array.isArray(firstDocuments) ||
    firstDocuments.length === 0 ||
    typeof firstDocuments[0] !== "string"
  )
    throw new Error("list_documents returned no real Hopper document");
  const currentDocument = await requireCurrentDocument(
    client,
    options,
    firstDocuments,
    requireSuccessfulTool,
  );
  const firstOverview = requireOverview(
    requireSuccessfulTool(overview, "binary_overview"),
    "binary_overview",
  );
  const firstAnalysis = await verifyCurrentTarget(client, options);
  const fixtureAnalysis = await verifyRealHopperFixture({
    client,
    options,
    document: currentDocument,
    oracle: fixtureTargets.oracle,
    normalizedResult: requireSuccessfulTool,
  });
  const switched = await client.callTool(
    { name: "open_binary", arguments: { path: targetB } },
    options,
  );
  if (switched.isError === true) throw new Error(textValue(switched));
  const secondSession = requireMcpResult(
    await fullSessionStatus(),
    "binary_session",
  );
  if (secondSession.path !== targetB)
    throw new Error("The real session did not switch to target B");
  requireHopperSelection(secondSession, {
    targetSupport: "supported",
    selected: true,
  });
  const secondOverview = await client.callTool(
    { name: "binary_overview", arguments: {} },
    options,
  );
  const verifiedSecondOverview = requireOverview(
    requireSuccessfulTool(secondOverview, "binary_overview"),
    "binary_overview after target switch",
  );
  const secondAnalysis = await verifyCurrentTarget(client, options);
  const largePagination = await openAndVerifyLargeFixture({
    client,
    options,
    normalizedResult: requireSuccessfulTool,
    path: largeTarget,
    expectedCount: fixtureTargets.largeOracle.symbolCount,
    symbolPrefix: fixtureTargets.largeOracle.symbolPrefix,
    stringPrefix: fixtureTargets.largeOracle.stringPrefix,
  });

  const processList = await execFileAsync("ps", ["-ax", "-o", "command="]);
  const bundledMcpRunning = processList.stdout
    .split("\n")
    .some((line) => line.trim().endsWith("/HopperMCPServer"));
  if (bundledMcpRunning) {
    throw new Error(
      "Hopper's bundled MCP server was running during verification",
    );
  }
  const diagnosticCount = requireSafeDiagnostics(stderrChunks);

  const closed = await client.callTool(
    { name: "close_binary", arguments: {} },
    options,
  );
  if (closed.isError === true) throw new Error(textValue(closed));
  const closedSession = requireMcpResult(
    await fullSessionStatus(),
    "binary_session",
  );
  if (closedSession.open !== false)
    throw new Error("The real session remained open after close_binary");

  summary = {
    toolCount: actualNames.length,
    documentCount: firstDocuments.length,
    overview: firstOverview,
    segmentCount: firstOverview.segment_count,
    analyses: [firstAnalysis, secondAnalysis],
    fixtureAnalysis,
    largePagination,
    fixtureManifest: fixtureTargets.manifestPath,
    bundledMcpRunning,
    stderrBytes,
    diagnosticCount,
    dynamicSession: true,
    providerBinding,
    targets: [targetA, targetB, largeTarget],
    targetHashes: [targetHashA, targetHashB, fixtureTargets.large.sha256],
    switched: true,
    secondOverview: verifiedSecondOverview,
  };
} finally {
  const keepAlive = setInterval(() => undefined, 100);
  try {
    await client.close();
    await transport.close();
  } finally {
    clearInterval(keepAlive);
  }
}

await new Promise((resolve) => setTimeout(resolve, 500));
const sessionsAfter = (await readdir("/tmp")).filter(
  (name) => name.startsWith("rea-") && !sessionsBefore.has(name),
);
if (sessionsAfter.length > 0) {
  throw new Error("The MCP runtime leaked a bridge session directory");
}
const afterCloseProcesses = await execFileAsync("ps", [
  "-ax",
  "-o",
  "command=",
]);
if (
  afterCloseProcesses.stdout
    .split("\n")
    .some((line) => line.includes("node dist/main.js"))
) {
  throw new Error(
    "The TypeScript MCP server remained alive after client close",
  );
}
if (summary === undefined)
  throw new Error("Real-Hopper verification did not produce a summary");
const completedVerifierRun = await completeVerifierRun(verifierRun);
await new Promise((resolve, reject) => {
  process.stdout.write(
    `${JSON.stringify({ verifier_run: completedVerifierRun, ...summary, cleanShutdown: true }, null, 2)}\n`,
    (cause) => {
      if (cause) reject(cause);
      else resolve();
    },
  );
});
