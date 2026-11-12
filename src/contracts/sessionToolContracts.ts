import { requireOutputSchema } from "./toolOutputSchemaPrimitives.js";
import { matchNativeFunctionsInputSchema } from "./native/functionMatchingContracts.js";
import { z } from "zod";

import { absoluteLocalPathStringSchema } from "../domain/localPath.js";
import {
  callPathRequestSchema,
  staticRuntimeCorrelationRequestSchema,
} from "./investigationInputContracts.js";
import { changedBehaviorInputSchema } from "../domain/changedBehavior.js";
import { functionComparisonInputSchema } from "../domain/functionComparisonSchemas.js";
import { processScenarioSchema } from "../domain/process/processScenario.js";
import {
  recordUnknownInputSchema,
  updateUnknownInputSchema,
} from "../domain/residualUnknown.js";
import { reconstructionVerificationInputSchema } from "../domain/reconstructionVerificationSchemas.js";
import { sessionOutputSchemas } from "./toolOutputSchemaGroups.js";
import {
  closeBinaryInputSchema,
  resetInvestigationInputSchema,
  openBundleResourcesInputSchema,
  openBinaryInputSchema,
} from "./sessionLifecycleInputs.js";
import { binarySessionInputSchema } from "./sessionStatusContract.js";
import { processComparisonInputSchema } from "./processComparisonContracts.js";
import { artifactComparisonInputSchema } from "./artifactComparisonContracts.js";
import {
  addressContextInputSchema,
  bundleComparisonMcpInputSchema,
  importEvidenceBundleInputSchema,
  listUnknownsInputSchema,
  navigationContextInputSchema,
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
  path: absoluteLocalPathStringSchema.describe(
    "Absolute local filesystem path for the exported evidence bundle; relative paths are rejected.",
  ),
  overwrite: z.boolean().default(false),
});

/** Target lifecycle tools available only on the long-lived MCP adapter. */
export const SESSION_TOOL_CONTRACTS = [
  session(
    "open_binary",
    "Open a validated local artifact or analysis database and bind its analysis provider. Switching target/provider can discard ephemeral Ghidra edits even if the later open fails; retained investigation Evidence does not restore them. Reopening the same target/profile retains the engine and edits. provider_id selects a provider or deterministic auto routing, with no failure fallback. Omitted format uses headers; format dos-com admits 1..65280 headerless bytes, while raw-binary requires architecture and entry_point and maps file offset 0 there. Optional snapshots must match target, provider and analysis profile; close/reopen before importing into a mutated engine. For Ghidra cross-process edits, set a private absolute REA_GHIDRA_CHECKPOINT_DIR at startup (stock ELF/PE/Mach-O on Linux/macOS); normal opens/closes restore/save metadata. Failed opens report selection_at_failure and target/provider at completion; use binary_session for current state. close_binary releases engine resources; reset_investigation clears retained records.",
    openBinaryInputSchema,
  ),
  session(
    "open_bundle_resources",
    "Open a local app bundle for read-only plist, Interface Builder, asset catalog, and keyed archive inspection without resolving or inventing its executable identity. This switches the shared session to a resource-only lane; executable analysis is unavailable until another target is opened.",
    openBundleResourcesInputSchema,
  ),
  session(
    "close_binary",
    "Release the active engine and owned resources while retaining investigation Evidence and complete Unknown history in memory. Drains earlier requests and queues later ones. If cleanup fails, keep this connection and retry close_binary without snapshot_path after the reported condition settles. Optional snapshot_path saves a target-bound snapshot first; resource-only sessions have no snapshot binding, existing files require overwrite, and failed saves keep the engine open. Metadata edits prevent immutable snapshot saves until recreation. Ghidra checkpoint mode saves metadata on normal close and retains the Program for retry if saving fails. Closing does not persist investigation records: export_evidence_bundle to save them, or reset_investigation to clear them.",
    closeBinaryInputSchema,
  ),
  session(
    "reset_investigation",
    "Discard retained Evidence and Unknown revision history, including engine replay/source bindings, while keeping a healthy active engine open. Drains earlier work and queues later requests. Optional save_path atomically syncs and publishes a complete bundle first; import_evidence_bundle restores its IDs/history. Cancellation, failed save or incomplete cleanup preserves records; any already-published checkpoint is reported. Without save_path, records are lost. binary_session reports the representation budget; no automatic persistence or eviction occurs.",
    resetInvestigationInputSchema,
  ),
  session(
    "binary_session",
    "Inspect current target, provider capabilities, analysis and server identity without starting analysis. Default summary reports Ghidra checkpoint/ephemeral mode in capabilities[].shared_limitations; detail complete adds diagnostics, candidate capabilities and tool flags. Set refresh_candidates true to recheck provider readiness without changing the active engine. analysis_provider_candidates_observed distinguishes fresh observations from selection-time facts. open_binary with provider_id can replace the engine and discard ephemeral edits; reopening without it reuses the route. release_verification is optional reported-version evidence, not executable authentication. omitted_fields names facts left out of summary.",
    binarySessionInputSchema,
  ),
  session(
    "export_evidence_bundle",
    "Atomically write the session's deterministic Evidence bundle to the requested local path. Existing files require overwrite: true; records and manifests use canonical byte-stable ordering.",
    exportEvidenceBundleInputSchema,
  ),
  session(
    "import_evidence_bundle",
    "Read the JSON bundle at the supplied local path, validate every Evidence ID and canonical manifest, then atomically merge it. Imported content is data only and is never executed. Import restores registry entries present in the bundle; questions embedded in Evidence do not automatically become Unknown registry entries.",
    importEvidenceBundleInputSchema,
  ),
  session(
    "capture_process_scenario",
    "Run a caller-selected command under a PTY and return process capture Evidence and unknowns. It runs with the user's permissions, can change files or use network, and is not a sandbox. dry_run validates and returns a rea.process-scenario-plan without launching. Command names use inherited PATH; cwd defaults to the caller's and environment overrides augment inheritance. Filesystem observation is opt-in through filesystem_observation_paths. Terminal size must satisfy columns × (rows + scrollback) <= 1,000,000 on every resize; dimensions are never clamped and this limit has no override. Environment keys reject =/NUL and REA_PROCESS_RUN_ID is reserved. With positive finalization_ms, timeout/idle sends identity-checked SIGTERM, observes until the interval ends, then sends SIGKILL once; exit.finalization records attempts and observed exit. Cancellation still ends the run immediately.",
    processScenarioSchema,
  ),
  session(
    "compare_process_captures",
    'Compare compatible process captures, inline or by {kind:"retained-evidence",evidence_id}, across terminal, interaction, lifecycle, process, filesystem, command-shim, HTTP and WebSocket observations. Optional trace_spec checks explicit partial-order or finite-trace assertions, including selected timing. Observer timing alone does not establish changed behavior; timestamps or sorting never establish concurrency. Missing, journal-free or truncated observations never establish equivalence.',
    processComparisonInputSchema,
  ),
  session(
    "compare_artifacts",
    'Compare complete artifact inventories by occurrence path, content identity, metadata and graph relations; root . identifies the outer container separately. Accepts complete inline Evidence, {kind:"retained-evidence",evidence_id} for inspect_artifact/nested inventory/retained summary, or {kind:"evidence-file",path:"/absolute/bundle.json"} with optional evidence_id. Summaries resolve to their complete parent in that session/source bundle; summary facts alone are insufficient. Returns every delta inline with both source identities; coverage gaps remain truncated or unknown, never equivalence. Includes FIT and legacy uImage components.',
    artifactComparisonInputSchema,
  ),
  session(
    "match_native_functions",
    "Pair two retained list_procedures inventories by unique exact symbols, then unique identical observed bytes. Optional same-context name/body/byte/dossier Evidence adds static facts; compatible CFG/call/string fingerprints propose unresolved groups only. Duplicate candidates stay unresolved, and only_left/right means unpaired within inputs, not proven addition/removal. Default summary retains the full matching for function-matches pages; complete returns every group. byte-sources identifies selected read_bytes Evidence: intersect IDs with function evidence_links. Dossier pairs supply retained-reference compare_functions inputs.",
    matchNativeFunctionsInputSchema,
  ),
  session(
    "compare_functions",
    "Compare two explicit analyze_function Evidence records or exact retained session references across identity, exact provider text, calls, references, strings, and address-normalized CFG topology. The same authenticated Evidence record or compatible same-artifact entry coordinates establish correspondence independently of symbol origin; metadata and text changes remain separate. Missing or provider-incompatible facets remain truncated or unknown; every conclusion cites both Evidence sets.",
    functionComparisonInputSchema,
  ),
  session(
    "compare_bundles",
    "Compare two canonical Evidence bundles by exact record membership, explicit one-to-one observation pairs, and complete residual-unknown revision histories. Supply absolute local filesystem paths; relative paths are rejected. Missing bundle members describe omission only, never behavioral equivalence; output is digest-anchored and returns every change inline.",
    bundleComparisonMcpInputSchema,
  ),
  session(
    "find_changed_behavior",
    "Aggregate validated process, artifact, and function comparison Evidence, supplied inline or by exact retained-evidence references from this session. Original records and their complete source closure remain authenticated; summaries do not substitute for comparisons. Runtime observations remain distinct from static behavior candidates; missing or incomplete comparisons produce unresolved findings, never causal claims. Returns every finding inline.",
    changedBehaviorInputSchema,
  ),
  session(
    "build_call_path",
    "Build every shortest direct-callee path from complete analyze_function Evidence supplied inline or by exact retained-evidence references. References reuse the complete parent of an analyze_function summary without resending dossiers. Uses exact canonical addresses; missing dossiers and provider mixing remain unknown, and every node and edge cites source Evidence.",
    callPathRequestSchema,
  ),
  session(
    "correlate_static_and_runtime",
    "Evaluate every explicit caller-declared hypothesis between static and runtime comparison Evidence supplied inline or by exact retained-evidence references. Similar names or paths are never auto-matched, consistent cochange never proves causality, and unknown or truncated inputs remain unresolved. Returns all correlations and their complete Evidence closure inline.",
    staticRuntimeCorrelationRequestSchema,
  ),
  session(
    "verify_reconstruction",
    "Verify a finite typed behavioral and structural specification against a canonical Evidence bundle. Pass means every declared claim has complete comparable authority—not global source equivalence; changed claims fail and missing, limited, or unresolved evidence stays unknown.",
    reconstructionVerificationInputSchema,
  ),
  session(
    "list_unknowns",
    "List tracked questions' current revisions in deterministic ID order, with exact status/severity/domain filters. Complete inline by default; offset/limit pages the filtered order, total counts matches and next_offset null means exhausted. Unresolved, contradicted and non-truth dispositions stay distinct. An empty registry does not mean retained Evidence has no residual questions; inspect that Evidence or its analysis view.",
    listUnknownsInputSchema,
  ),
  session(
    "record_unknown",
    "Create one deterministic residual unknown and immutable mutation evidence. Its scope is the active binary analysis target digest, or null without an active target; supporting Evidence does not select the scope. Scope contributes to stable identity. Validates all evidence and relationship references, and rejects duplicate stable identity.",
    recordUnknownInputSchema,
  ),
  session(
    "update_unknown",
    "Append a full-state revision to one tracked question, with immutable mutation Evidence. Requires exact expected_revision; stale writers fail rather than overwrite. The question keeps its original scope, while mutation Evidence uses the active target digest or null and can have a different subject.",
    updateUnknownInputSchema,
  ),
  session(
    "verify_unknown_resolution",
    "Check a tracked question's current resolution against bundled Evidence, required authority/confidence/environment and revision integrity. Withdrawn and out-of-scope dispositions do not establish truth.",
    verifyUnknownResolutionInputSchema,
  ),
  session(
    "get_evidence_bundle",
    "Read retained Evidence and tracked questions without rerunning providers. Default complete returns an importable canonical bundle. detail summary lists record metadata; records pages complete records with unchanged IDs and missing direct evidence_links, but is not an importable bundle. detail links inspects retained/missing links without payloads; traversal retained-closure follows retained links and defaults to missing rows. Summary/records/links filters accept Evidence ID, operation, target SHA-256, analysis-profile digest or canonical procedure address. Metadata keeps retention distinct from truncated/unavailable source coverage. Use a discovered evidence_id with a compatible inspect_analysis_view to read selected facts.",
    getEvidenceBundleInputSchema,
  ),
  {
    ...session(
      "get_navigation_context",
      "Return the selected document, current address, and containing/current procedure in one provider-neutral result. The result reflects sequential provider observations, not an atomic cursor snapshot; a cursor outside any procedure returns procedure: null.",
      navigationContextInputSchema,
    ),
    requiresActiveTarget: true,
  },
  {
    ...session(
      "inspect_address_context",
      "Inspect one explicit reproducible address for its analyzed name, containing procedure, regular and inline comments, and matching bookmarks. Each unsupported facet returns a typed unavailable outcome. A facet rejected for invalid input, source Evidence integrity, or a resource constraint retains its canonical error and recovery alongside successful facets. Use xrefs, assembly, or pseudocode for those deeper views.",
      addressContextInputSchema,
    ),
    requiresActiveTarget: true,
  },
] as const satisfies readonly ToolContract[];
