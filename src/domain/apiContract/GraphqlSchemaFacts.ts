import {
  Kind,
  isTypeDefinitionNode,
  isTypeExtensionNode,
  print,
  type DocumentNode,
  type TypeNode,
} from "graphql";
import type { GraphqlType, GraphqlField } from "./graphqlContract.js";
import type { GraphqlSourceDocument } from "./GraphqlDocuments.js";
import {
  GraphqlInventory,
  graphqlIdentity,
  graphqlSource,
} from "./GraphqlInventory.js";

const typeKinds: Partial<Record<Kind, GraphqlType["kind"]>> = {
  [Kind.OBJECT_TYPE_DEFINITION]: "object",
  [Kind.OBJECT_TYPE_EXTENSION]: "object",
  [Kind.INTERFACE_TYPE_DEFINITION]: "interface",
  [Kind.INTERFACE_TYPE_EXTENSION]: "interface",
  [Kind.INPUT_OBJECT_TYPE_DEFINITION]: "input-object",
  [Kind.INPUT_OBJECT_TYPE_EXTENSION]: "input-object",
  [Kind.SCALAR_TYPE_DEFINITION]: "scalar",
  [Kind.SCALAR_TYPE_EXTENSION]: "scalar",
  [Kind.ENUM_TYPE_DEFINITION]: "enum",
  [Kind.ENUM_TYPE_EXTENSION]: "enum",
  [Kind.UNION_TYPE_DEFINITION]: "union",
  [Kind.UNION_TYPE_EXTENSION]: "union",
};
const nonTypeSDL = new Set<string>([
  Kind.SCHEMA_DEFINITION,
  Kind.SCHEMA_EXTENSION,
  Kind.DIRECTIVE_DEFINITION,
  Kind.DIRECTIVE_EXTENSION,
]);
const namedType = (input: TypeNode): string => {
  let node = input;
  while (node.kind !== Kind.NAMED_TYPE) node = node.type;
  return node.name.value;
};

/** Declaration occurrences remain separate even if SDL model construction rejects duplicates. */
export function* collectGraphqlSchemaFacts(
  document: DocumentNode,
  input: GraphqlSourceDocument,
  inventory: GraphqlInventory,
): Generator<void> {
  inventory.schemaDeclarations = "partial";
  let examined = 0;
  for (const definition of document.definitions) {
    if (!isTypeDefinitionNode(definition) && !isTypeExtensionNode(definition)) {
      if (!nonTypeSDL.has(definition.kind))
        inventory.diagnostic(
          "non-schema-definition",
          "This schema input contains a definition outside SDL type/field interpretation.",
          "schema",
          graphqlSource(input.artifact, "schema", definition),
        );
      continue;
    }
    const kind = typeKinds[definition.kind];
    if (kind === undefined)
      throw new Error("Missing GraphQL declaration kind.");
    const source = graphqlSource(input.artifact, "schema", definition);
    const row: GraphqlType = {
      type_id: graphqlIdentity("graphql_type", source),
      name: definition.name.value,
      kind,
      extension: isTypeExtensionNode(definition),
      interfaces:
        "interfaces" in definition
          ? (definition.interfaces ?? []).map((node) => node.name.value)
          : [],
      members:
        "types" in definition
          ? (definition.types ?? []).map((node) => node.name.value)
          : [],
      source,
    };
    inventory.retain(row);
    inventory.types.push(row);
    if ("fields" in definition) {
      for (const field of definition.fields ?? []) {
        const location = graphqlSource(input.artifact, "schema", field);
        const fact: GraphqlField = {
          field_id: graphqlIdentity("graphql_field", location),
          field_key: row.name + "." + field.name.value,
          owner_type_id: row.type_id,
          owner_type_name: row.name,
          kind: kind === "input-object" ? "input" : "output",
          name: field.name.value,
          type_ref: print(field.type),
          named_type: namedType(field.type),
          source: location,
        };
        inventory.retain(fact);
        inventory.fields.push(fact);
        inventory.fieldIdsByStart.set(location.start_utf16, fact.field_id);
        if (++examined % 128 === 0) yield;
      }
    }
    if (++examined % 128 === 0) yield;
  }
  inventory.schemaDeclarations = "complete";
}
