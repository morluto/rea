import { buildASTSchema, version, type GraphQLSchema } from "graphql";
import { AnalysisError } from "../analysisErrorBase.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../analysisErrorCore.js";
import { err, ok, type Result } from "../result.js";
import type { GraphqlContract } from "./graphqlContract.js";
import { API_CONTRACT_OPERATION } from "./apiContract.js";
import { GraphqlInventory } from "./GraphqlInventory.js";
import {
  GraphqlDocumentRefusal,
  parseGraphqlDocument,
  type GraphqlSourceDocument,
} from "./GraphqlDocuments.js";
import { collectGraphqlSchemaFacts } from "./GraphqlSchemaFacts.js";
import { collectGraphqlOperationFacts } from "./GraphqlOperationFacts.js";

/** One syntax/model interpretation owns all declarations and field bindings. */
export function* parseGraphqlContractSteps(
  schema: GraphqlSourceDocument,
  operations?: GraphqlSourceDocument,
): Generator<void, Result<GraphqlContract, AnalysisError>> {
  const inventory = new GraphqlInventory(
    schema.artifact,
    operations?.artifact ?? null,
    version,
  );
  try {
    const document = parseGraphqlDocument(schema, "schema");
    yield* collectGraphqlSchemaFacts(document, schema, inventory);
    let model: GraphQLSchema | undefined;
    try {
      const constructed = buildASTSchema(document);
      const roots = {
        query: constructed.getQueryType()?.name ?? null,
        mutation: constructed.getMutationType()?.name ?? null,
        subscription: constructed.getSubscriptionType()?.name ?? null,
      };
      inventory.schemaModel = "constructed";
      inventory.roots = roots;
      model = constructed;
    } catch (cause) {
      if (cause instanceof RangeError)
        throw new AnalysisResourceConstraintError(
          API_CONTRACT_OPERATION,
          "memory",
          "GraphQL schema construction exceeded a runtime representation allowance.",
          {},
          { cause },
        );
      if (!(cause instanceof Error)) throw cause;
      inventory.diagnostic(
        "schema-model-unavailable",
        "The supplied SDL could not construct a schema model. Declaration occurrences remain available; bindings stay unknown. Full schema validation diagnostics are outside this profile.",
        "schema",
      );
    }
    yield;
    if (operations !== undefined) {
      try {
        const operationDocument = parseGraphqlDocument(
          operations,
          "operations",
        );
        yield* collectGraphqlOperationFacts(
          operationDocument,
          operations,
          inventory,
          model,
        );
      } catch (cause) {
        if (!(cause instanceof GraphqlDocumentRefusal)) throw cause;
        inventory.diagnostic(
          "operations-parse-refused",
          "The operation document was refused by the GraphQL syntax/parser allowance checks; inspect this source location and the documented parser allowances.",
          "operations",
          cause.source,
        );
      }
    }
    return ok(inventory.finish());
  } catch (cause) {
    let error: AnalysisError;
    if (cause instanceof GraphqlDocumentRefusal) {
      inventory.diagnostic(
        "schema-parse-refused",
        "The schema document was refused by GraphQL syntax/parser allowance checks; inspect this source location and the documented allowances.",
        "schema",
        cause.source,
      );
      error = new AnalysisInputError(API_CONTRACT_OPERATION, { cause }, [
        {
          path: ["path"],
          reason: "invalid_format",
          message:
            "The schema document was refused by the GraphQL syntax/parser allowance checks. Inspect its source location and documented allowances.",
        },
      ]);
    } else if (cause instanceof AnalysisError) error = cause;
    else throw cause;
    error.retainPartialObservation(inventory.finish(true));
    return err(error);
  }
}
