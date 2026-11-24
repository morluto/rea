import {
  inspectPythonPycInputSchema,
  pythonPycSchema,
} from "../../domain/python/pythonPyc.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata, evidenceEffects } from "../toolEffects.js";
import { analysisDetailOutputSchemaOf } from "../analysisDetail.js";
import { z } from "zod";
import {
  pythonPycCodeObjectsViewResultSchema,
  pythonPycSummaryViewResultSchema,
} from "../../domain/analysisView/summarySchemas/pythonPycSummarySchemas.js";
import {
  pythonPycCompleteDeliveryShape,
  pythonPycSummaryDeliveryShape,
} from "../../domain/analysisView/pythonPycView.js";
import { presentRootDiscriminator } from "../../domain/schemaAnnotations.js";

/** Delivery selection does not change provider inputs or complete Evidence identity. */
export const inspectPythonPycRequestSchema = presentRootDiscriminator(
  z.discriminatedUnion("detail", [
    inspectPythonPycInputSchema.extend(pythonPycCompleteDeliveryShape),
    inspectPythonPycInputSchema.extend(pythonPycSummaryDeliveryShape),
  ]),
  "detail",
);

/** Static CPython pyc inspection is independent of active native-analysis providers. */
export const PYTHON_PYC_TOOL_CONTRACTS = [
  {
    name: "inspect_python_pyc",
    availability: "standalone",
    cli: true,
    ...toolContractMetadata("inspect_python_pyc", evidenceEffects),
    kind: "artifact-provider",
    requiresActiveTarget: true,
    description:
      "Inspect local CPython 3.7–3.15 .pyc headers and nested code objects without executing bytecode, invoking Python or recovering source. Returns pinned version/header fields, names, constant summaries and bytecode lengths/digests; nested_code links code constants, not runtime calls. Default complete returns full Evidence; detail summary retains it for inspect_analysis_view kind python-pyc, collection code_objects, with exact names/indices/fields and paging. source_index preserves same-name alternatives. Unsupported magics/layouts, truncation and exhausted budgets fail without partial success. A header does not prove matching .py source exists.",
    inputSchema: inspectPythonPycRequestSchema,
    outputSchema: analysisDetailOutputSchemaOf(
      pythonPycSchema,
      z.union([
        pythonPycSummaryViewResultSchema,
        pythonPycCodeObjectsViewResultSchema,
      ]),
    ),
    examples: [
      {
        title:
          "Return selected function facts immediately and retain the complete report",
        input: {
          path: "/artifacts/module.pyc",
          detail: "summary",
          view: {
            kind: "python-pyc",
            collection: "code_objects",
            names: ["parse_args"],
            fields: ["name", "qualname", "bytecode", "nested_code"],
          },
        },
      },
      {
        title: "Inspect a CPython 3.12 pyc header and nested code objects",
        input: { path: "/artifacts/module.pyc" },
      },
      {
        title:
          "Retain the complete pyc report and return only its header and coverage",
        input: { path: "/artifacts/module.pyc", detail: "summary" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
