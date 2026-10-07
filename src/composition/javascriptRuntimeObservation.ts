import type { JavaScriptRuntimeObservationPort } from "../application/JavaScriptRuntimeObservationPort.js";
import { V8InspectorProvider } from "../browser/V8InspectorProvider.js";

/** Construct a fresh provider without opening a target or acquiring an engine. */
export const createJavaScriptRuntimeObservationProvider =
  (): JavaScriptRuntimeObservationPort => new V8InspectorProvider();
