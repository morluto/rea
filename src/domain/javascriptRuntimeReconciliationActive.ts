import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";

import canonicalize from "canonicalize";
import { z } from "zod";

import {
  classifyBrowserCompleteness,
  type BrowserCompleteness,
} from "./browserCompleteness.js";
import {
  electronActiveObservationResultSchema,
  type ElectronActiveObservationResult,
} from "./electronActiveObservation.js";
import type { Evidence } from "./evidence.js";
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
      approved: z.literal(true),
      application_path: absolutePathSchema,
      application_root: absolutePathSchema,
    })
    .passthrough()
    .parse(evidence.parameters);
  if (
    result.application.application_path !== parameters.application_path ||
    !isWithinRoot(
      parameters.application_root,
      result.application.application_path,
    )
  )
    throw new TypeError(
      "Active Electron Evidence application path disagrees with its approved root",
    );
  return {
    kind: "electron-active",
    evidence,
    inspection: normalizeInspection(result),
    captureSha256: digestCanonical(result),
    scriptsCompleteWithinScope: false,
  };
};

const absolutePathSchema = z.string().min(1).max(16_384).refine(isAbsolute);

const assertIdentity = (evidence: Evidence): void => {
  if (
    evidence.operation !== "capture_electron_scenario" ||
    evidence.predicate_type !== "rea.electron-active-scenario/v1" ||
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
    target_id: `electron-active:${digestCanonical(result.application.application_path).slice(0, 32)}`,
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
    truncatedSections: new Set(
      result.windows_truncated ||
      result.processes.truncated ||
      result.ipc.truncated ||
      result.timeline.truncated
        ? ["timeline"]
        : [],
    ),
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
      timeline_events: result.timeline.truncated ? result.timeline.observed : 0,
    },
  }),
});

const digestCanonical = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("Runtime reconciliation could not canonicalize input");
  return createHash("sha256").update(encoded).digest("hex");
};

const isWithinRoot = (root: string, path: string): boolean => {
  const remainder = relative(root, path);
  return (
    remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder))
  );
};
