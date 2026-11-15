import { graphqlContractSchema } from "../domain/apiContract/graphqlContract.js";
import { z } from "zod";
import { apiContractSchema } from "../domain/apiContract/apiContract.js";
import { inspectApiContractInputSchema } from "../domain/apiContract/apiContractQuery.js";
import {
  apiContractSummaryViewResultSchema,
  apiContractPageViewResultSchema,
  graphqlContractPageViewResultSchema,
} from "../domain/analysisView/analysisViewResult.js";
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
      'Inspect declared APIs in local OpenAPI JSON or GraphQL SDL without a session, network requests or target execution. OpenAPI 3.0/3.1/3.2 returns inline method/path operations with source pointers; references remain unresolved. format:"graphql-sdl" returns types/fields and optional operations_path bindings, preserving aliases, fragment/spread owners and unknowns without expanding fragments or claiming full operation validation. Default summary retains Evidence; view overrides detail. For HTTP rows use view {kind:"api-contract",collection:"operations",methods:["GET"],limit:20}; GraphQL uses view {kind:"graphql-contract",collection:"references",limit:20}. inspect_analysis_view pages the same retained facts. Source declaration coverage stays separate from page exhaustion; paging does not increase parser allowances. Introspection, runtime behavior and contract comparison are outside scope.',
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
