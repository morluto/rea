import { javaScriptRuntime } from "../../domain/runtimeVersion.js";

/** The Node capture decoder runs on this executable; Bun accepts but ignores V8 heap flags. */
export const NODE_CAPTURE_HEAP_ENFORCED =
  javaScriptRuntime(process.versions).id === "node";
