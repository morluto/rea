import { graphqlContractSchema } from "../domain/apiContract/graphqlContract.js";
import { z } from "zod";
import { apiContractSchema } from "../domain/apiContract/apiContract.js";
import { inspectApiContractInputSchema } from "../domain/apiContract/apiContractQuery.js";
import {
  apiContractSummaryViewResultSchema,
  apiContractPageViewResultSchema,
  graphqlContractPageViewResultSchema,
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
      "Inspect local OpenAPI JSON (default) or GraphQL SDL offline; no session, network, endpoint requests or target execution. OpenAPI 3.0/3.1/3.2 inventories inline path operations with exact method/path keys, source JSON Pointers and source-scoped IDs; references stay unresolved and malformed siblings explicit. GraphQL format graphql-sdl inventories type/field declarations and optional operations_path field bindings, operation/fragment owners and explicit spread edges without expanding fragments. It preserves aliases, wrappers, source digests/UTF-16 ranges and unknown/model-only bindings; field resolution is not full operation validation. Introspection, contract diff and runtime behavior are outside scope. Default summary retains complete Evidence; view selects facts immediately, overriding detail. Retained inspect_analysis_view supports kind api-contract or graphql-contract with exact batch filters, fields and paging. Coverage describes examined declarations, independently of page exhaustion. Each file and expanded facts have 32 MiB allowances plus heap admission. GraphQL additionally bounds lexical tokens (262144), comments (65536) and subsequent AST traversal depth (128). Reply paging does not increase parser allowances.",
    inputSchema: inspectApiContractInputSchema,
    outputSchema: evidenceResultOf(
      z.union([
        apiContractSchema,
        graphqlContractSchema,
        apiContractSummaryViewResultSchema,
        apiContractPageViewResultSchema,
        graphqlContractPageViewResultSchema,
      ]),
    ),
    examples: [
      {
        title: "Bind local GraphQL selections to supplied SDL fields",
        input: {
          path: "/artifacts/schema.graphql",
          format: "graphql-sdl",
          operations_path: "/artifacts/queries.graphql",
          view: {
            kind: "graphql-contract",
            collection: "references",
            limit: 20,
          },
        },
      },
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
