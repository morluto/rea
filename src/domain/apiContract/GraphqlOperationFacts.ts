import {
  Kind,
  TypeInfo,
  visit,
  type DocumentNode,
  type GraphQLSchema,
  type FieldNode,
  type FragmentSpreadNode,
} from "graphql";
import type {
  GraphqlDefinition,
  GraphqlReference,
  GraphqlSpread,
} from "./graphqlContract.js";
import type { GraphqlSourceDocument } from "./GraphqlDocuments.js";
import {
  GraphqlInventory,
  graphqlIdentity,
  graphqlSource,
} from "./GraphqlInventory.js";

interface DefinitionContext {
  readonly definitionId: string;
  readonly input: GraphqlSourceDocument;
  readonly inventory: GraphqlInventory;
  readonly info: TypeInfo | undefined;
  readonly fragments: ReadonlyMap<string, readonly GraphqlDefinition[]>;
}

const reference = (
  node: FieldNode,
  parentId: string | null,
  { definitionId, input, inventory, info }: DefinitionContext,
): GraphqlReference => {
  const field = info?.getFieldDef(),
    parent = info?.getParentType();
  const position = field?.astNode?.loc?.start;
  const fieldId =
    position === undefined
      ? undefined
      : inventory.fieldIdsByStart.get(position);
  const source = graphqlSource(input.artifact, "operations", node);
  const state =
    fieldId !== undefined
      ? "resolved"
      : field != null
        ? "model-only"
        : "unknown";
  const reason =
    fieldId !== undefined
      ? null
      : field != null
        ? "no-sdl-source"
        : info === undefined
          ? "schema-model-unavailable"
          : parent == null
            ? "parent-type-unavailable"
            : "unknown-field";
  return {
    reference_id: graphqlIdentity("graphql_reference", source),
    definition_id: definitionId,
    parent_reference_id: parentId,
    field_name: node.name.value,
    response_key: node.alias?.value ?? node.name.value,
    parent_type_name: parent?.name ?? null,
    schema_field_id: fieldId ?? null,
    result_type: field == null ? null : String(field.type),
    state,
    reason,
    source,
  };
};

const spread = (
  node: FragmentSpreadNode,
  parentId: string | null,
  { definitionId, input, inventory, fragments }: DefinitionContext,
) => {
  const candidates = fragments.get(node.name.value) ?? [];
  const source = graphqlSource(input.artifact, "operations", node);
  const row: GraphqlSpread = {
    spread_id: graphqlIdentity("graphql_spread", source),
    definition_id: definitionId,
    parent_reference_id: parentId,
    name: node.name.value,
    target_definition_id:
      candidates.length === 1 ? candidates[0]!.definition_id : null,
    matching_definitions: candidates.length,
    state:
      candidates.length === 1
        ? "resolved"
        : candidates.length === 0
          ? "missing"
          : "ambiguous",
    source,
  };
  inventory.retain(row);
  inventory.spreads.push(row);
};

/** Record each definition once; fragment edges never recursively expand its body. */
export function* collectGraphqlOperationFacts(
  document: DocumentNode,
  input: GraphqlSourceDocument,
  inventory: GraphqlInventory,
  model: GraphQLSchema | undefined,
): Generator<void> {
  inventory.operations = "partial";
  const fragments = new Map<string, GraphqlDefinition[]>();
  const owners = new Map<number, GraphqlDefinition>();
  for (const definition of document.definitions) {
    if (
      definition.kind !== Kind.OPERATION_DEFINITION &&
      definition.kind !== Kind.FRAGMENT_DEFINITION
    ) {
      inventory.diagnostic(
        "non-operation-definition",
        "This operation input contains a definition outside operation/fragment interpretation.",
        "operations",
        graphqlSource(input.artifact, "operations", definition),
      );
      continue;
    }
    const source = graphqlSource(input.artifact, "operations", definition);
    const row: GraphqlDefinition = {
      definition_id: graphqlIdentity("graphql_definition", source),
      kind:
        definition.kind === Kind.FRAGMENT_DEFINITION
          ? "fragment"
          : definition.operation,
      name: definition.name?.value ?? null,
      type_condition:
        definition.kind === Kind.FRAGMENT_DEFINITION
          ? definition.typeCondition.name.value
          : null,
      source,
    };
    inventory.retain(row);
    inventory.definitions.push(row);
    owners.set(source.start_utf16, row);
    if (row.kind === "fragment" && row.name !== null) {
      const candidates = fragments.get(row.name) ?? [];
      candidates.push(row);
      fragments.set(row.name, candidates);
    }
    yield;
  }
  for (const definition of document.definitions) {
    const owner =
      definition.loc === undefined
        ? undefined
        : owners.get(definition.loc.start);
    if (owner === undefined) continue;
    const info = model === undefined ? undefined : new TypeInfo(model);
    const context = {
      definitionId: owner.definition_id,
      input,
      inventory,
      info,
      fragments,
    };
    const parents: string[] = [];
    visit(definition, {
      enter(node) {
        info?.enter(node);
        if (node.kind === Kind.FIELD) {
          const row = reference(node, parents.at(-1) ?? null, context);
          inventory.retain(row);
          inventory.references.push(row);
          parents.push(row.reference_id);
        } else if (node.kind === Kind.FRAGMENT_SPREAD) {
          spread(node, parents.at(-1) ?? null, context);
        }
      },
      leave(node) {
        if (node.kind === Kind.FIELD) parents.pop();
        info?.leave(node);
      },
    });
    yield;
  }
  inventory.operations = "complete";
}
