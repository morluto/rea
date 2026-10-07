import type { JavaScriptRuntimeObservationPort } from "../application/javascript/JavaScriptRuntimeObservationPort.js";
import { V8InspectorProvider } from "../inspector/V8InspectorProvider.js";

/** Construct a fresh provider without opening a target or acquiring an engine. */
export const createJavaScriptRuntimeObservationProvider =
  (): JavaScriptRuntimeObservationPort => new V8InspectorProvider();
