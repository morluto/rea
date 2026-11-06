import { z } from "zod";
import { apiContractSchema } from "../domain/apiContract/apiContract.js";
import { inspectApiContractInputSchema } from "../domain/apiContract/apiContractQuery.js";
import {
  apiContractSummaryViewResultSchema,
  apiContractPageViewResultSchema,
} from "../domain/analysisView/analysisView.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "./toolEffects.js";
import type { ToolContract } from "./toolContractTypes.js";

/** Named, provider-free contract for declarations in one local specification. */
export const API_CONTRACT_TOOL_CONTRACTS = [
  {
    name: "inspect_api_contract",
    ...toolContractMetadata("inspect_api_contract"),
    kind: "application",
    description:
      "Inventory declared operations in a local OpenAPI 3.0/3.1/3.2 JSON document offline. No target session, network, endpoint requests or reference resolution. Returns exact method/path, source JSON Pointers, source-scoped IDs and separate exact method/path keys. Candidate runtime behavior is never inferred from a contract. Default summary retains complete Evidence; optional view returns selected operations, unresolved Path Items or diagnostics immediately and takes precedence over detail. Retained inspect_analysis_view kind api-contract supports exact batch ID/method/path selection, fields and paging. Coverage describes inline paths only; callbacks/webhooks, schemas, servers, parameters and security remain unanalyzed. Malformed siblings and unresolved references remain explicit; this is not full OpenAPI validation. File and expanded-facts allowances are each 32 MiB, with JSON parsing additionally admitted against available heap and the shared nesting limit.",
    inputSchema: inspectApiContractInputSchema,
    outputSchema: evidenceResultOf(
      z.union([
        apiContractSchema,
        apiContractSummaryViewResultSchema,
        apiContractPageViewResultSchema,
      ]),
    ),
    examples: [
      {
        title:
          "Read selected declared HTTP operations without contacting servers",
        input: {
          path: "/artifacts/openapi.json",
          view: {
            kind: "api-contract",
            collection: "operations",
            methods: ["GET"],
            limit: 20,
          },
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
