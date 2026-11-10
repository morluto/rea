import { GraphQLError, Source, parse, visit, type DocumentNode } from "graphql";
import { AnalysisResourceConstraintError } from "../analysisErrorCore.js";
import {
  API_CONTRACT_OPERATION,
  API_CONTRACT_MAX_FILE_BYTES,
  type ApiContractArtifact,
} from "./apiContract.js";
import {
  GRAPHQL_CONTRACT_LIMITS,
  type GraphqlSource,
} from "./graphqlContract.js";

export interface GraphqlSourceDocument {
  readonly artifact: ApiContractArtifact;
  readonly text: string;
}

/** The library does not distinguish syntax and parser-policy errors with a stable code. */
export class GraphqlDocumentRefusal extends Error {
  readonly source: GraphqlSource | null;
  constructor(
    cause: GraphQLError,
    document: GraphqlSourceDocument,
    role: GraphqlSource["role"],
  ) {
    super("The GraphQL parser refused this document.", { cause });
    const offset = cause.positions?.[0],
      location = cause.locations?.[0];
    this.source =
      offset === undefined || location === undefined
        ? null
        : {
            role,
            sha256: document.artifact.sha256,
            start_utf16: offset,
            end_utf16: offset,
            line: location.line,
            column: location.column,
          };
  }
}

/** Public parser allowances bound allocation; iterative AST admission bounds subsequent traversal. */
export const parseGraphqlDocument = (
  document: GraphqlSourceDocument,
  role: GraphqlSource["role"],
): DocumentNode => {
  try {
    const parsed = parse(new Source(document.text, document.artifact.path), {
      maxLexicalTokens: GRAPHQL_CONTRACT_LIMITS.lexicalTokens,
      maxComments: GRAPHQL_CONTRACT_LIMITS.comments,
      maxSourceLength: API_CONTRACT_MAX_FILE_BYTES,
    });
    let depth = 0;
    visit(parsed, {
      enter() {
        depth++;
        if (depth > GRAPHQL_CONTRACT_LIMITS.astDepth)
          throw new AnalysisResourceConstraintError(
            API_CONTRACT_OPERATION,
            "memory",
            "GraphQL AST nesting exceeds the 128-level traversal allowance.",
            { max_ast_depth: GRAPHQL_CONTRACT_LIMITS.astDepth },
          );
      },
      leave() {
        depth--;
      },
    });
    return parsed;
  } catch (cause) {
    if (cause instanceof GraphQLError)
      throw new GraphqlDocumentRefusal(cause, document, role);
    if (cause instanceof RangeError)
      throw new AnalysisResourceConstraintError(
        API_CONTRACT_OPERATION,
        "memory",
        "GraphQL parsing exceeded a runtime representation allowance.",
        { parser: "graphql-js" },
        {
          cause,
          remediationAction:
            "Use a smaller, less deeply nested complete document.",
        },
      );
    throw cause;
  }
};
