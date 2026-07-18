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
  readonly executionContextFrames: Map<string, string>;
  readonly network: Map<string, NetworkState>;
  readonly allowedWebSockets: Set<string>;
  console: WebPageInspection["console"]["events"];
  websockets: WebPageInspection["network"]["websocket_events"];
  responseMetadata: WebPageInspection["metadata"]["responses"];
  agentHints: WebPageInspection["metadata"]["agent_hints"];
  readonly completeness: CdpCaptureCompleteness;
  originViolation: boolean;
  navigationDuringCapture: boolean;
  mainFrameId: string | undefined;
  consoleTextBytes: number;
  jsonBodyBytes: number;
  websocketShapeBytes: number;
}
