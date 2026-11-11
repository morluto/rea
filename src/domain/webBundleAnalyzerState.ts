import type { WebPageInspection } from "./browserObservationSchemas.js";
import type { WebBundleAnalysis } from "./webBundleAnalysis.js";
import {
  DEFAULT_WEB_BUNDLE_ENDPOINT_LITERAL_ADMISSION,
  type WebBundleEndpointLiteralAdmission,
} from "./webBundleEndpointLiteralBudget.js";

type BundleObservations = WebBundleAnalysis["observations"];
type BrowserScript = WebPageInspection["scripts"]["items"][number];
type IncludedSource = Extract<BrowserScript["source"], { included: true }>;

/** Captured script whose source bytes are available for inert analysis. */
export type IncludedScript = Omit<BrowserScript, "source"> & {
  readonly source: IncludedSource;
};

/** Mutable facts shared by per-script inspection and bundle result assembly. */
export interface AnalysisAccumulator {
  readonly edges: BundleObservations["chunks"]["edges"];
  readonly routes: BundleObservations["routes"];
  readonly endpoints: BundleObservations["endpoints"];
  readonly webMcp: BundleObservations["webmcp_declarations"];
  readonly inferences: WebBundleAnalysis["inferences"];
  readonly seen: Set<string>;
  visitedNodes: number;
  parsedScripts: number;
  readonly failedScripts: string[];
  readonly recoveredScripts: string[];
  readonly widenedScripts: string[];
  readonly endpointLiterals: WebBundleEndpointLiteralAdmission;
  endpointLiteralAdmitted: number;
  endpointLiteralOmitted: number;
  endpointLiteralOmittedExact: boolean;
}

export const createWebBundleAnalysisAccumulator = (
  endpointLiterals: WebBundleEndpointLiteralAdmission = DEFAULT_WEB_BUNDLE_ENDPOINT_LITERAL_ADMISSION,
): AnalysisAccumulator => ({
  edges: [],
  routes: [],
  endpoints: [],
  webMcp: [],
  inferences: [],
  seen: new Set(),
  visitedNodes: 0,
  parsedScripts: 0,
  failedScripts: [],
  recoveredScripts: [],
  widenedScripts: [],
  endpointLiterals,
  endpointLiteralAdmitted: 0,
  endpointLiteralOmitted: 0,
  endpointLiteralOmittedExact: true,
});

export const isIncludedScript = (
  script: BrowserScript,
): script is IncludedScript => script.source.included;
