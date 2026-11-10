import { AnalysisResourceConstraintError } from "../analysisErrorCore.js";
import {
  DEFAULT_WASM_INTERFACE_REPRESENTATION_BYTES,
  MAX_WASM_INTERFACE_REPRESENTATION_BYTES,
} from "./wasmInterface.js";

/** One selected interface allowance, shared by nested producer reads and comparison. */
export class WasmInterfaceBudget {
  #remaining: number;
  readonly maximumBytes: number;
  readonly source: "default" | "request";
  constructor(
    maximumBytes?: number,
    readonly operation = "inspect_wasm_artifact",
  ) {
    this.maximumBytes =
      maximumBytes ?? DEFAULT_WASM_INTERFACE_REPRESENTATION_BYTES;
    this.source = maximumBytes === undefined ? "default" : "request";
    this.#remaining = this.maximumBytes;
  }
  reserve(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.#remaining)
      throw new AnalysisResourceConstraintError(
        this.operation,
        "capacity",
        `Typed WASM interface representation exceeds max_interface_bytes (${String(this.maximumBytes)} bytes)`,
        {
          maximum_bytes: this.maximumBytes,
          default_bytes: DEFAULT_WASM_INTERFACE_REPRESENTATION_BYTES,
          maximum_supported_bytes: MAX_WASM_INTERFACE_REPRESENTATION_BYTES,
          source: this.source,
          unit: "bytes",
        },
        {
          retryable: false,
          remediationAction: `${this.maximumBytes < MAX_WASM_INTERFACE_REPRESENTATION_BYTES ? `Raise max_interface_bytes above ${String(this.maximumBytes)} bytes (maximum ${String(MAX_WASM_INTERFACE_REPRESENTATION_BYTES)}) on the next ${this.operation} call.` : `max_interface_bytes is already at the runtime representation maximum of ${String(MAX_WASM_INTERFACE_REPRESENTATION_BYTES)} bytes; no higher interface allowance is supported. A comparison may select only imports or exports; otherwise report the unsupported complete representation.`} No restart is required. Other output, heap and deadline controls do not raise this allowance. A comparison cannot restore facts omitted from partial producer Evidence; inspect the original module with a larger producer budget first when that budget is below its maximum.`,
        },
      );
    this.#remaining -= bytes;
  }
}
