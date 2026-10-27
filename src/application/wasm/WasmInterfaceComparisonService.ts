import {
  WASM_INTERFACE_REPRESENTATION_BYTES,
  wasmInterfaceEntryRepresentationBytes,
} from "../../domain/wasm/wasmInterface.js";
import { setImmediate } from "node:timers/promises";
import { ARTIFACT_COMPARISON_PROVIDER } from "../../domain/comparisonEvidenceIdentity.js";
import {
  compareWasmInterfacesInputSchema,
  wasmInterfaceComparisonSchema,
} from "../../contracts/wasm/wasmComparisonContracts.js";
import {
  createEvidence,
  parseEvidence,
  type Evidence,
} from "../../domain/evidence.js";
import {
  wasmArtifactSchema,
  wasmArtifactMatchesSubject,
  type WasmArtifact,
} from "../../domain/wasm/wasmArtifact.js";
import type { WasmInterfaceEntry } from "../../domain/wasm/wasmInterface.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, type Result } from "../../domain/result.js";
import {
  resolvePairedEvidenceRequest,
  type EvidenceLookup,
} from "../EvidenceInputResolver.js";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { z } from "zod";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";

const OPERATION = "compare_wasm_interfaces";
const parseInspection = (
  raw: unknown,
): { evidence: Evidence; result: WasmArtifact } => {
  const evidence = parseEvidence(raw);
  if (evidence.operation !== "inspect_wasm_artifact")
    throw new TypeError("Expected complete inspect_wasm_artifact Evidence");
  const result = wasmArtifactSchema.parse(evidence.normalized_result);
  if (
    !wasmArtifactMatchesSubject(
      result.artifact,
      evidence.subject === null
        ? null
        : {
            path: evidence.subject.local_path,
            sha256: evidence.subject.digest.sha256,
            format: evidence.subject.format,
          },
    ) ||
    evidence.parameters.path !== result.artifact.path
  )
    throw new TypeError(
      "WASM Evidence subject/selection does not match normalized artifact identity",
    );
  return { evidence, result };
};

/** Compare only producer-owned typed facts; no raw WAT or original file is reread. */
export const compareWasmInterfaces = async (
  rawInput: unknown,
  options?: ExecutionOptions,
  lookup?: EvidenceLookup,
): Promise<Result<Evidence, AnalysisError>> => {
  if (options?.signal?.aborted)
    return err(
      new AnalysisCancelledError(OPERATION, { cause: options.signal.reason }),
    );
  const parsed = compareWasmInterfacesInputSchema.safeParse(rawInput);
  if (!parsed.success)
    return err(
      analysisInputErrorFromIssues(OPERATION, parsed.error.issues, rawInput),
    );
  const resolved = resolvePairedEvidenceRequest(parsed.data, lookup);
  if (!resolved.ok) return resolved;
  const assertActive = () => {
    if (options?.signal?.aborted)
      throw new AnalysisCancelledError(OPERATION, {
        cause: options.signal.reason,
      });
  };
  try {
    await setImmediate();
    assertActive();
    const left = parseInspection(resolved.value.left);
    const right = parseInspection(resolved.value.right);
    const scope = parsed.data.scope;
    const selected = (entry: WasmInterfaceEntry): boolean =>
      scope === "both" ||
      entry.direction === (scope === "imports" ? "import" : "export");
    const groups = new Map<
      string,
      {
        left: WasmInterfaceEntry[];
        right: WasmInterfaceEntry[];
        entry: WasmInterfaceEntry;
      }
    >();
    let work = 0;
    for (const [side, inspection] of [
      ["left", left],
      ["right", right],
    ] as const) {
      for (const entry of inspection.result.interface?.entries ?? []) {
        if (++work % 256 === 0) {
          await setImmediate();
          assertActive();
        }
        if (!selected(entry)) continue;
        const key = JSON.stringify([entry.direction, entry.module, entry.name]);
        let group = groups.get(key);
        if (group === undefined) {
          group = { left: [], right: [], entry };
          groups.set(key, group);
        }
        group[side].push(entry);
      }
    }
    const knownInventory = (inspection: typeof left): boolean =>
      inspection.result.interface?.state === "complete";
    const changes: z.infer<typeof wasmInterfaceComparisonSchema>["changes"] =
      [];
    const summary = {
      added: 0,
      removed: 0,
      changed: 0,
      unchanged: 0,
      unknown: 0,
    };
    let remaining = WASM_INTERFACE_REPRESENTATION_BYTES;
    for (const group of groups.values()) {
      remaining -=
        512 +
        group.left.reduce(
          (sum, entry) => sum + wasmInterfaceEntryRepresentationBytes(entry),
          0,
        ) +
        group.right.reduce(
          (sum, entry) => sum + wasmInterfaceEntryRepresentationBytes(entry),
          0,
        );
      if (remaining < 0)
        throw new AnalysisResourceConstraintError(
          OPERATION,
          "capacity",
          "WASM comparison exceeds typed interface representation capacity",
          { maximum_bytes: WASM_INTERFACE_REPRESENTATION_BYTES },
          fixedAllowanceOptions(
            "The WASM interface comparison inventory",
            "bytes",
          ),
        );
      if (++work % 256 === 0) {
        await setImmediate();
        assertActive();
      }
      let state: keyof typeof summary;
      let reason: string | null = null;
      const l = group.left[0];
      const r = group.right[0];
      if (group.left.length > 1 || group.right.length > 1) {
        state = "unknown";
        reason =
          "Duplicate interface names are ambiguous; all occurrences retained";
      } else if (!knownInventory(left) || !knownInventory(right)) {
        state = "unknown";
        reason =
          "Incomplete interface inventories cannot establish per-key uniqueness or absence";
      } else if (
        [l, r].some(
          (entry) =>
            entry !== undefined &&
            (entry.signature === null ||
              entry.issue !== null ||
              entry.kind === "unknown"),
        )
      ) {
        state = "unknown";
        reason =
          "Signature/type semantics were not admitted for every present entry";
      } else if (l === undefined) state = "added";
      else if (r === undefined) state = "removed";
      else if (l.kind !== r.kind) state = "changed";
      else
        state =
          JSON.stringify(l.signature) === JSON.stringify(r.signature)
            ? "unchanged"
            : "changed";
      summary[state]++;
      changes.push({
        direction: group.entry.direction,
        module: group.entry.module,
        name: group.entry.name,
        state,
        left: group.left,
        right: group.right,
        reason,
      });
    }
    const compareText = (a: string, b: string): number =>
      a < b ? -1 : a > b ? 1 : 0;
    changes.sort(
      (a, b) =>
        compareText(a.direction, b.direction) ||
        compareText(a.module ?? "", b.module ?? "") ||
        compareText(a.name, b.name),
    );
    const coverage =
      left.result.interface === undefined &&
      right.result.interface === undefined
        ? "unknown"
        : !knownInventory(left) || !knownInventory(right) || summary.unknown > 0
          ? "partial"
          : "complete-within-inputs";
    const limitations = [
      "Exact declared interface equality is not runtime/ABI compatibility, successful linking or original-source identity.",
      "Typed facts come from the selected validated WABT decoding; unsupported signature semantics and duplicate names remain unknown.",
    ];
    const report = wasmInterfaceComparisonSchema.parse({
      left: {
        evidence_id: left.evidence.evidence_id,
        artifact: left.result.artifact,
      },
      right: {
        evidence_id: right.evidence.evidence_id,
        artifact: right.result.artifact,
      },
      scope,
      coverage,
      changes,
      summary,
      limitations,
    });
    const evidence = createEvidence(undefined, ARTIFACT_COMPARISON_PROVIDER, {
      operation: OPERATION,
      predicateType: "rea.wasm-interface-comparison",
      parameters: {
        left_evidence_id: left.evidence.evidence_id,
        right_evidence_id: right.evidence.evidence_id,
        scope,
      },
      result: report,
      confidence: "derived",
      authority: "analyst-inference",
      limitations,
      evidenceLinks: [left.evidence.evidence_id, right.evidence.evidence_id],
    });
    await setImmediate();
    return completeProviderEvidence(evidence, options?.signal);
  } catch (cause: unknown) {
    if (cause instanceof AnalysisError) return err(cause);
    return err(
      new AnalysisInputError(OPERATION, { cause }, [
        {
          path: [],
          reason: "invalid_value",
          message: cause instanceof Error ? cause.message : String(cause),
        },
      ]),
    );
  }
};
