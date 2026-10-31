import { webPageInspectionSchema } from "../../domain/browserObservationSchemas.js";
import { retainedBrowserScenarioCaptureSchema } from "../../domain/browserScenarioCapture.js";
import { parseEvidence } from "../../domain/evidence.js";
import { browserWorkerEvidenceScopeSchema } from "../../domain/browserWorkerEvidenceScope.js";
import type {
  CapturedWebScript,
  WebScriptExportResult,
} from "../../domain/webScriptExport.js";
import { pageScripts } from "./PageScriptCapture.js";
import { scenarioScripts } from "./ScenarioScriptCapture.js";

/** Capture-specific parsing and source selection, independent of publication. */
export interface ScriptCaptureAdapter {
  readonly operation: string;
  readonly parse: (input: unknown) => SelectedScriptCapture | undefined;
}

/** Verified source records with the original capture coverage and limitations. */
export interface SelectedScriptCapture {
  readonly kind: WebScriptExportResult["capture_kind"];
  readonly completeness: WebScriptExportResult["capture_completeness"];
  readonly workerCoverage?: WebScriptExportResult["worker_coverage"];
  readonly scripts: readonly CapturedWebScript[];
  readonly limitations: readonly string[];
}

/** Built-in adapters; add capture formats here without changing the publisher. */
export const SCRIPT_CAPTURE_ADAPTERS: readonly ScriptCaptureAdapter[] = [
  {
    operation: "inspect_web_page",
    parse: (input) => {
      const parsed = webPageInspectionSchema.safeParse(input);
      if (!parsed.success) return undefined;
      const workerCoverage: NonNullable<
        WebScriptExportResult["worker_coverage"]
      > = [];
      const identifiedWorkers: typeof parsed.data.workers = [];
      let unknownWorkers = 0;
      let unidentifiedSources = 0;
      for (const worker of parsed.data.workers) {
        if (worker.target_id.length === 0) {
          unknownWorkers += 1;
          unidentifiedSources += worker.observation?.scripts.length ?? 0;
          continue;
        }
        identifiedWorkers.push(worker);
        workerCoverage.push({
          target_id: worker.target_id,
          completeness: worker.observation?.completeness ?? null,
          limitations: worker.observation?.limitations ?? [],
        });
      }
      return {
        kind: "page-inspection",
        completeness: parsed.data.completeness,
        workerCoverage,
        scripts: pageScripts({
          scripts: parsed.data.scripts,
          workers: identifiedWorkers,
        }),
        limitations: [
          ...parsed.data.limitations,
          ...(unknownWorkers === 0
            ? []
            : [
                `Worker identity was unavailable for ${String(unknownWorkers)} observations; their per-worker coverage and ${String(unidentifiedSources)} sources were omitted from export. The original capture retains those partial facts.`,
              ]),
        ],
      };
    },
  },
  {
    operation: "capture_browser_scenario",
    parse: (input) => {
      const parsed = retainedBrowserScenarioCaptureSchema.safeParse(input);
      return parsed.success
        ? {
            kind: "browser-scenario",
            completeness: parsed.data.completeness,
            scripts: scenarioScripts(parsed.data),
            limitations: parsed.data.limitations,
          }
        : undefined;
    },
  },
];

/** Reject unsupported/malformed captures and tampered Evidence before writing. */
export const selectScriptCapture = (
  raw: unknown,
  adapters: readonly ScriptCaptureAdapter[] = SCRIPT_CAPTURE_ADAPTERS,
): SelectedScriptCapture & { readonly sourceEvidenceId: string | null } => {
  if (
    typeof raw === "object" &&
    raw !== null &&
    ("normalized_result" in raw || "evidence_id" in raw)
  ) {
    const evidence = parseEvidence(raw);
    if (evidence.operation === "inspect_web_page")
      browserWorkerEvidenceScopeSchema.parse(evidence);
    const selected = adapters
      .find(({ operation }) => operation === evidence.operation)
      ?.parse(evidence.normalized_result);
    if (selected !== undefined)
      return { ...selected, sourceEvidenceId: evidence.evidence_id };
  } else {
    for (const adapter of adapters) {
      const selected = adapter.parse(raw);
      if (selected !== undefined)
        return { ...selected, sourceEvidenceId: null };
    }
  }
  throw new TypeError(
    "Expected a valid inspect_web_page or capture_browser_scenario capture, with retained script sources or response bytes. Evidence envelopes must have a matching operation and semantic identifier.",
  );
};
