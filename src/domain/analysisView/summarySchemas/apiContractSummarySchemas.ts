import { z } from "zod";
import { apiContractArtifactSchema } from "../../apiContract/apiContract.js";
import { apiContractViewRequestSchema } from "../../apiContract/apiContractQuery.js";
import { graphqlContractViewRequestSchema } from "../../apiContract/graphqlContractQuery.js";
import {
  summaryViewResultBase,
  viewResultBaseFields,
} from "../analysisViewBase.js";
import {
  apiContractViewContextSchema,
  apiContractViewItemsSchema,
} from "../apiContractView.js";
import {
  graphqlContractViewContextSchema,
  graphqlContractViewItemsSchema,
} from "../graphqlContractView.js";

export const apiContractSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  parent_operation: z.literal("inspect_api_contract"),
  summary: z.union([
    apiContractViewContextSchema,
    graphqlContractViewContextSchema,
  ]),
});

export const apiContractPageViewResultSchema = z.strictObject({
  ...viewResultBaseFields,
  ...apiContractViewContextSchema.shape,
  kind: z.literal("api-contract"),
  artifact: apiContractArtifactSchema,
  parent_operation: z.literal("inspect_api_contract"),
  view: apiContractViewRequestSchema,
  items: apiContractViewItemsSchema,
});

export const graphqlContractPageViewResultSchema = z.strictObject({
  ...viewResultBaseFields,
  ...graphqlContractViewContextSchema.shape,
  parent_operation: z.literal("inspect_api_contract"),
  view: graphqlContractViewRequestSchema,
  items: graphqlContractViewItemsSchema,
});
