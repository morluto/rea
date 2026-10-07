import { isAbsolute } from "node:path";

import { canonicalDigest } from "../comparisonSemantics.js";
import { isPathWithinRoot } from "../localPath.js";
import { z } from "zod";

import {
  classifyBrowserCompleteness,
  type BrowserCompleteness,
} from "../browserCompleteness.js";
import {
  electronActiveObservationResultSchema,
  type ElectronActiveObservationResult,
} from "./electronActiveObservation.js";
import type { Evidence } from "../evidence.js";
import type { ParsedRuntimeCapture } from "./javascriptRuntimeReconciliationParsing.js";

/** Parse active Electron Evidence as a bounded, target-only runtime capture. */
export const parseActiveElectronCapture = (
  evidence: Evidence,
): ParsedRuntimeCapture => {
  assertIdentity(evidence);
  const result = electronActiveObservationResultSchema.parse(
    evidence.normalized_result,
  );
  const parameters = z
    .object({
      application_path: absolutePathSchema,
      application_root: absolutePathSchema,
    })
    .passthrough()
    .parse(evidence.parameters);
  if (
    result.application.application_path !== parameters.application_path ||
    !isPathWithinRoot(
      parameters.application_root,
      result.application.application_path,
    )
  )
    throw new TypeError(
      "Active Electron Evidence application path disagrees with its configured root",
    );
  return {
    kind: "electron-active",
    evidence,
    inspection: normalizeInspection(result),
    captureSha256: canonicalDigest(result, "Runtime reconciliation"),
    scriptsCompleteWithinScope: false,
  };
};

const absolutePathSchema = z.string().min(1).refine(isAbsolute);

const assertIdentity = (evidence: Evidence): void => {
  if (
    evidence.operation !== "capture_electron_scenario" ||
    evidence.predicate_type !== "rea.electron-active-scenario" ||
    evidence.provider.id !== "rea-playwright-electron-active" ||
    evidence.provider.name !==
      "REA Playwright active Electron observation provider" ||
    evidence.provider.version !== "1" ||
    evidence.authority !== "controlled-replay" ||
    evidence.confidence !== "observed"
  )
    throw new TypeError(
      "Evidence does not match the supported capture_electron_scenario contract",
    );
};

const normalizeInspection = (
  result: ElectronActiveObservationResult,
): {
  readonly target: {
    readonly target_id: string;
    readonly type: string;
    readonly title: string;
    readonly attached: boolean;
    readonly file_path: string;
  };
  readonly frames: readonly [];
  readonly scripts: { readonly items: readonly [] };
  readonly workers: readonly [];
  readonly completeness: BrowserCompleteness;
} => ({
  target: {
    target_id: `electron-active:${canonicalDigest(result.application.application_path, "Runtime reconciliation").slice(0, 32)}`,
    type: "electron-application",
    title: result.application.application_path,
    attached: true,
    file_path: result.application.application_path,
  },
  frames: [],
  scripts: { items: [] },
  workers: [],
  completeness: classifyBrowserCompleteness({
    policyFilteredSections: new Set(),
    attachLimitedSections: new Set(),
    truncatedSections: new Set(),
    unavailableSections: new Set([
      "frames",
      "scripts",
      "script_sources",
      "workers",
    ]),
    excluded: [],
    droppedEvents: {
      scripts: 0,
      network_requests: 0,
      console_events: 0,
      websocket_connections: 0,
      websocket_frames: 0,
      webmcp_tools: 0,
      timeline_events: 0,
    },
  }),
});
