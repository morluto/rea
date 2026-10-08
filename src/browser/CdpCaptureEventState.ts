import type {
  InspectWebPageInput,
  WebPageInspection,
} from "../domain/browserObservation.js";
import type { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import type { CapturedScript, NetworkState } from "./CdpCaptureEventTypes.js";

export interface CdpCaptureEventsState {
  readonly input: InspectWebPageInput;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly scripts: Map<string, CapturedScript>;
  readonly scriptMetadataBudgetOmissionsById: Map<string, true>;
  rejectedScriptMetadataBudgetCount: number;
  rejectedSourceMapMetadataBudgetCount: number;
  readonly scriptMetadataBytesById: Map<string, number>;
  retainedScriptMetadataBytes: number;
  readonly executionContextFrames: Map<string, string>;
  readonly network: Map<string, NetworkState>;
  readonly networkRequestTimestamps: Map<string, number>;
  readonly malformedRedirectRequestIds: Set<string>;
  readonly allowedWebSockets: Set<string>;
  console: WebPageInspection["console"]["events"];
  websockets: WebPageInspection["network"]["websocket_events"];
  responseMetadata: WebPageInspection["metadata"]["responses"];
  agentHints: WebPageInspection["metadata"]["agent_hints"];
  readonly completeness: CdpCaptureCompleteness;
  originViolation: boolean;
  navigationDuringCapture: boolean;
  mainFrameId: string | undefined;
  /**
   * Identity of the document last observed in the main frame. `frameNavigated`
   * re-fires for the same document, so this is what distinguishes a real
   * document change from a duplicate event.
   */
  committedDocument: string | undefined;
}
