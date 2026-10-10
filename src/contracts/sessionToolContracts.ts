import { z } from "zod";

import { isAbsolute } from "node:path";
import { localPathStringSchema } from "../domain/localPath.js";
import { artifactComparisonInputSchema } from "../domain/artifactComparison.js";
import { bundleComparisonInputSchema } from "../domain/bundleComparison.js";
import { callPathInputSchema } from "../domain/callPathSchemas.js";
import { changedBehaviorInputSchema } from "../domain/changedBehavior.js";
import { functionComparisonInputSchema } from "../domain/functionComparisonSchemas.js";
import { processScenarioSchema } from "../domain/process/processScenario.js";
import {
  recordUnknownInputSchema,
  updateUnknownInputSchema,
} from "../domain/residualUnknown.js";
import { reconstructionVerificationInputSchema } from "../domain/reconstructionVerificationSchemas.js";
import { staticRuntimeCorrelationInputSchema } from "../domain/staticRuntimeCorrelation.js";
import { sessionOutputSchemas } from "./toolOutputSchemaGroups.js";
import { requireOutputSchema } from "./toolOutputSchemaPrimitives.js";
import {
  closeBinaryInputSchema,
  openBinaryInputSchema,
} from "./sessionLifecycleInputs.js";
import { binarySessionInputSchema } from "./sessionStatusContract.js";
import {
  addressContextInputSchema,
  importEvidenceBundleInputSchema,
  listUnknownsInputSchema,
  navigationContextInputSchema,
  processComparisonInputSchema,
  getEvidenceBundleInputSchema,
  verifyUnknownResolutionInputSchema,
} from "./sessionToolSchemas.js";
import { examplesFor } from "./toolContractHelpers.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";

const session = <
  Name extends keyof typeof sessionOutputSchemas,
  Schema extends z.ZodObject,
>(
  name: Name,
  description: string,
  inputSchema: Schema,
) =>
  ({
    name,
    ...toolContractMetadata(name),
    description,
    kind: "session",
    inputSchema,
    outputSchema: requireOutputSchema(sessionOutputSchemas, name),
    examples: examplesFor(name, inputSchema),
  }) satisfies ToolContract<Name, Schema>;

/** Session-owned Evidence bundle export options. */
export const exportEvidenceBundleInputSchema = z.strictObject({
  path: localPathStringSchema
    .refine(isAbsolute, {
      message:
        "path must be an absolute local filesystem path (for example /tmp/rea/evidence.json or C:\\rea\\evidence.json)",
    })
    .describe(
      "Absolute local filesystem path for the exported evidence bundle; relative paths are rejected.",
    ),
  overwrite: z.boolean().default(false),
});

/** Target lifecycle tools available only on the long-lived MCP adapter. */
export const SESSION_TOOL_CONTRACTS = [
  session(
    "open_binary",
    "Open a local executable, application bundle, archive, JavaScript, source map, plist, or analysis database after validation. format=dos-com explicitly interprets 1..65280 headerless bytes as a DOS COM analysis image; omission preserves header-based detection. provider_id selects one deep provider or deterministic auto selection; the binding remains stable until close or an explicit switch, with no failure fallback. Reopening the same target and profile retains its active database and metadata edits. An optional analysis snapshot is imported atomically and must match the binary identity, concrete provider, and canonical analysis profile exactly; importing into a session with metadata mutations requires closing and reopening it first.",
    openBinaryInputSchema,
  ),
  session(
    "close_binary",
    "Drain earlier provider requests, optionally write a provider-neutral analysis snapshot atomically to the caller-supplied path, then close the active target and every provider resource started for it. Later provider requests wait until this lifecycle operation finishes. Existing files require explicit overwrite; a failed save leaves the session open so cached analysis is not lost. Metadata edits prevent immutable snapshot saves until the session is recreated; export_evidence_bundle preserves mutable observations before closing without a snapshot.",
    closeBinaryInputSchema,
  ),
  session(
    "binary_session",
    "Report the complete current target, provider, capability availability, client-feature, analysis, and server-identity status without starting analysis.",
    binarySessionInputSchema,
  ),
  session(
    "export_evidence_bundle",
    "Atomically write the session's deterministic Evidence bundle to the requested local path. Existing files require overwrite: true; records and manifests use canonical byte-stable ordering.",
    exportEvidenceBundleInputSchema,
  ),
  session(
    "import_evidence_bundle",
    "Read the JSON bundle at the supplied local path, validate every Evidence ID and canonical manifest, then atomically merge it. Imported content is data only and is never executed.",
    importEvidenceBundleInputSchema,
  ),
  session(
    "capture_process_scenario",
    "Run one caller-selected command under a PTY and return process capture Evidence with residual unknowns. A command name resolves through the inherited PATH; the working directory defaults to the caller's current directory; host environment variables are inherited with scenario overrides. Environment keys cannot contain '=' or NUL, and REA_PROCESS_RUN_ID is reserved for process ownership. Filesystem snapshots are opt-in through filesystem_observation_paths. The target runs with the current user's permissions; this is not a security sandbox.",
    processScenarioSchema,
  ),
  session(
    "compare_process_captures",
    "Compare two compatible process capture observations across terminal, interaction, lifecycle, process, filesystem, command-shim, HTTP, and WebSocket evidence. Optional trace_spec validates exact events against an explicit partial order or finite trace language; concurrency is never inferred from timestamps or broad sorting. Missing, journal-free, or truncated observations are never treated as equivalent.",
    processComparisonInputSchema,
  ),
  session(
    "compare_artifacts",
    "Compare complete artifact inventories by logical occurrence path, content identity, metadata, and graph relations. Pass the inventory Evidence nested in each inspect_artifact result as left and right. Every delta cites both inputs, and gaps yield truncated or unknown, never equivalence. Returns every change inline.",
    artifactComparisonInputSchema,
  ),
  session(
    "compare_functions",
    "Compare two explicit sets of analyze_function Evidence across identity, exact provider text, calls, references, strings, and address-normalized CFG topology. Missing or provider-incompatible facets remain truncated or unknown; every conclusion cites both Evidence sets.",
    functionComparisonInputSchema,
  ),
  session(
    "compare_bundles",
    "Compare two canonical Evidence bundles by exact record membership, explicit one-to-one observation pairs, and complete residual-unknown revision histories. Missing bundle members describe omission only, never behavioral equivalence; output is digest-anchored and returns every change inline.",
    bundleComparisonInputSchema,
  ),
  session(
    "find_changed_behavior",
    "Aggregate validated process and artifact comparison Evidence. Runtime observations remain distinct from static behavior candidates; missing or incomplete comparisons produce unresolved findings, never causal claims. Returns every finding inline.",
    changedBehaviorInputSchema,
  ),
  session(
    "build_call_path",
    "Build every shortest direct-callee path inline from complete analyze_function Evidence records using exact canonical addresses. Missing dossiers and provider mixing remain unknown; every node and edge cites source Evidence.",
    callPathInputSchema,
  ),
  session(
    "correlate_static_and_runtime",
    "Evaluate every explicit caller-declared hypothesis between exact static comparison findings and runtime comparison dimensions. Similar names or paths are never auto-matched, consistent cochange never proves causality, and unknown or truncated inputs remain unresolved. Returns all correlations and their complete Evidence closure inline.",
    staticRuntimeCorrelationInputSchema,
  ),
  session(
    "verify_reconstruction",
    "Verify a finite typed behavioral and structural specification against a canonical Evidence bundle. Pass means every declared claim has complete comparable authority—not global source equivalence; changed claims fail and missing, limited, or unresolved evidence stays unknown.",
    reconstructionVerificationInputSchema,
  ),
  session(
    "list_unknowns",
    "List every current residual-unknown head in deterministic ID order, with optional exact status, severity, and domain filters. Results are complete and inline. This is read-only; unresolved, contradicted, and non-truth dispositions remain distinct.",
    listUnknownsInputSchema,
  ),
  session(
    "record_unknown",
    "Create one deterministic residual unknown and immutable mutation evidence. Validates all evidence and relationship references, and rejects duplicate stable identity.",
    recordUnknownInputSchema,
  ),
  session(
    "update_unknown",
    "Append one immutable full-state revision and mutation evidence. Requires exact expected_revision; stale concurrent writers fail instead of overwriting newer analysis.",
    updateUnknownInputSchema,
  ),
  session(
    "verify_unknown_resolution",
    "Revalidate the current residual-unknown head against live bundled evidence, exact authority/confidence/environment requirements, and revision integrity. Withdrawn and out-of-scope dispositions are not truth claims.",
    verifyUnknownResolutionInputSchema,
  ),
  session(
    "get_evidence_bundle",
    "Return every Evidence record and residual unknown currently retained by this session as one inline bundle for direct inspection or follow-up workflows.",
    getEvidenceBundleInputSchema,
  ),
  session(
    "get_navigation_context",
    "Return the selected document, current address, and containing/current procedure in one provider-neutral result. The result reflects sequential provider observations, not an atomic cursor snapshot; a cursor outside any procedure returns procedure: null.",
    navigationContextInputSchema,
  ),
  session(
    "inspect_address_context",
    "Inspect one explicit reproducible address for its analyzed name, containing procedure, regular and inline comments, and matching bookmarks. Each unsupported facet returns a typed unavailable outcome; use xrefs, assembly, or pseudocode for those deeper views.",
    addressContextInputSchema,
  ),
] as const satisfies readonly ToolContract[];
