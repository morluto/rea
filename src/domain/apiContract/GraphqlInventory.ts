import type { ASTNode } from "graphql";
import { digestCanonicalValue } from "../canonicalDigest.js";
import { AnalysisResourceConstraintError } from "../analysisErrorCore.js";
import {
  API_CONTRACT_FACT_BYTES,
  API_CONTRACT_OPERATION,
  type ApiContractArtifact,
} from "./apiContract.js";
import {
  GRAPHQL_CONTRACT_PROFILE,
  type GraphqlContract,
  type GraphqlSource,
} from "./graphqlContract.js";

export const graphqlIdentity = (prefix: string, value: unknown): string =>
  prefix + "_" + digestCanonicalValue(value);

/** Positions come from the parser's tokens; do not rescan the source per fact. */
export const graphqlSource = (
  artifact: ApiContractArtifact,
  role: GraphqlSource["role"],
  node: ASTNode,
): GraphqlSource => {
  const location = node.loc;
  if (location === undefined)
    throw new Error("The GraphQL parser omitted a required source location.");
  return {
    role,
    sha256: artifact.sha256,
    start_utf16: location.start,
    end_utf16: location.end,
    line: location.startToken.line,
    column: location.startToken.column,
  };
};

/** One read owns compact declarations, bindings, indices and their resource charge. */
export class GraphqlInventory {
  readonly types: GraphqlContract["types"] = [];
  readonly fields: GraphqlContract["fields"] = [];
  readonly definitions: GraphqlContract["definitions"] = [];
  readonly references: GraphqlContract["references"] = [];
  readonly spreads: GraphqlContract["fragment_spreads"] = [];
  readonly diagnostics: GraphqlContract["diagnostics"] = [];
  readonly fieldIdsByStart = new Map<number, string>();
  schemaDeclarations: GraphqlContract["source_coverage"]["schema_declarations"] =
    "unavailable";
  schemaModel: GraphqlContract["source_coverage"]["schema_model"] =
    "unavailable";
  operations: GraphqlContract["source_coverage"]["operations"];
  roots: GraphqlContract["model_roots"] = {
    query: null,
    mutation: null,
    subscription: null,
  };
  #bytes = 0;
  constructor(
    readonly artifact: ApiContractArtifact,
    readonly operationArtifact: ApiContractArtifact | null,
    readonly interpreterVersion: string,
    requestedOperations = operationArtifact !== null,
  ) {
    this.operations = requestedOperations ? "unavailable" : "not-supplied";
  }

  retain(value: unknown): void {
    this.#bytes += 512 + Buffer.byteLength(JSON.stringify(value)) * 4;
    if (this.#bytes > API_CONTRACT_FACT_BYTES)
      throw new AnalysisResourceConstraintError(
        API_CONTRACT_OPERATION,
        "memory",
        "GraphQL facts exceed the 32 MiB retained representation allowance.",
        { retained_fact_allowance: API_CONTRACT_FACT_BYTES },
        {
          remediationAction:
            "Select smaller complete schema/operation documents; reply paging does not raise parser allowances.",
        },
      );
  }

  diagnostic(
    code: string,
    message: string,
    role: GraphqlSource["role"],
    source: GraphqlSource | null = null,
  ): void {
    const row = {
      diagnostic_id: graphqlIdentity("graphql_diagnostic", [
        this.artifact.sha256,
        this.operationArtifact?.sha256 ?? null,
        source,
        role,
        code,
        this.diagnostics.length,
      ]),
      code,
      message,
      source_role: role,
      source,
    };
    this.retain(row);
    this.diagnostics.push(row);
  }

  finish(incomplete = false): GraphqlContract {
    let unknownReferences = 0,
      modelOnly = 0,
      unresolvedSpreads = 0;
    for (const row of this.references) {
      if (row.state === "unknown") unknownReferences++;
      if (row.state === "model-only") modelOnly++;
    }
    for (const row of this.spreads)
      if (row.state !== "resolved") unresolvedSpreads++;
    const partial =
      incomplete ||
      this.schemaDeclarations !== "complete" ||
      this.schemaModel !== "constructed" ||
      (this.operations !== "complete" && this.operations !== "not-supplied") ||
      unknownReferences > 0 ||
      unresolvedSpreads > 0 ||
      this.diagnostics.length > 0;
    return {
      kind: "graphql-contract",
      format: "graphql-sdl",
      contract_id: graphqlIdentity("graphql_contract", [
        this.artifact.sha256,
        this.operationArtifact?.sha256 ?? null,
        GRAPHQL_CONTRACT_PROFILE,
      ]),
      decoder_profile: GRAPHQL_CONTRACT_PROFILE,
      interpreter: { id: "graphql-js", version: this.interpreterVersion },
      artifact: this.artifact,
      operations_artifact: this.operationArtifact,
      offset_units: "utf16-code-units",
      model_roots: this.roots,
      types: this.types,
      fields: this.fields,
      definitions: this.definitions,
      references: this.references,
      fragment_spreads: this.spreads,
      diagnostics: this.diagnostics,
      summary: {
        types: this.types.length,
        fields: this.fields.length,
        definitions: this.definitions.length,
        references: this.references.length,
        unknown_references: unknownReferences,
        model_only_references: modelOnly,
        fragment_spreads: this.spreads.length,
        unresolved_spreads: unresolvedSpreads,
        diagnostics: this.diagnostics.length,
      },
      source_coverage: {
        status: partial ? "partial" : "complete-within-scope",
        schema_declarations: this.schemaDeclarations,
        schema_model: this.schemaModel,
        operations:
          incomplete && this.operations === "complete"
            ? "partial"
            : this.operations,
        operation_validation: "field-resolution-only",
        endpoint_behavior: "unknown",
      },
      limitations: [
        ...(incomplete
          ? [
              "Import stopped before the requested interpretation completed; retained rows are partial observations.",
            ]
          : []),
        "Facts describe supplied SDL and operation text. Schema field bindings are derivations from that SDL and the identified GraphQL library model; reachability, execution and authorization remain unknown.",
        "Only type/field declarations, operation/fragment owners, field bindings and explicit fragment-spread edges are interpreted. Arguments, defaults, descriptions, directive behavior, enum values, full operation validation, introspection JSON and version comparison are outside this profile.",
        "Fragment definitions are visited once in their declared type scope; spreads are retained as edges without expansion. Resolved field bindings do not establish that a whole operation is valid or that a fragment can execute in every spread context.",
        "Model-only bindings have no matching declaration in the supplied SDL. Missing or ambiguous declarations and unavailable models remain explicit.",
        "Each supplied file is an independently verified byte snapshot; the pair is not an atomic filesystem observation. UTF-16 offsets and parser token line/column values address decoded UTF-8 text, including an optional BOM.",
        "Original document bytes are identified by SHA-256 rather than embedded. Complete interpreted Evidence remains available separately from selected replies.",
      ],
    };
  }
}
