import { otlpTraceSchema } from "../domain/otlpTrace/otlpTrace.js";
import { inspectOtlpTraceInputSchema } from "../domain/otlpTrace/otlpTraceQuery.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "./toolEffects.js";
import type { ToolContract } from "./toolContractTypes.js";

/** Named, provider-free contract for one caller-supplied OTLP trace export. */
export const OTLP_TRACE_TOOL_CONTRACTS = [
  {
    name: "inspect_otlp_trace",
    ...toolContractMetadata("inspect_otlp_trace"),
    kind: "application",
    description:
      "Inventory spans, parent-child links and timing in one caller-supplied OTLP JSON trace export offline. REA never contacts a collector or observability backend, fetches linked resources, or executes the recorded application. Only the OTLP JSON encoding is decoded; protobuf exports are not supported. Trace, span and parent identifiers are preserved as recorded, and a parent that the export does not contain is reported as an orphan instead of being guessed; only spans that declare no parent are listed as roots. Duplicate identifiers and parent cycles are reported rather than resolved. Timestamps stay exactly as recorded with no clock-skew correction, and a duration is reported only when the recorded interval is non-negative. Attribute values with credential-carrying keys are redacted by default, and array and key-value kinds report only their element count. An absent span never proves that an operation did not occur.",
    inputSchema: inspectOtlpTraceInputSchema,
    outputSchema: evidenceResultOf(otlpTraceSchema),
    examples: [
      {
        title: "Read a saved OTLP JSON trace export without a collector",
        input: { path: "/artifacts/traces.json" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
