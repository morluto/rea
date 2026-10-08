import type { JsonValue } from "../../domain/jsonValue.js";
import type {
  JavaScriptSemanticBinding,
  JavaScriptSemanticValue,
} from "../../domain/javascript/javascriptSemanticIr.js";
import {
  retainSemanticGraphNode,
  addSemanticGraphRelation,
} from "./JavaScriptSemanticGraphConstruction.js";
import type { SemanticFlowProjectionContext } from "./JavaScriptSemanticGraphFlowProjection.js";

/** Project bounded literal values and object slots for exact query seeds. */
export const projectSemanticValues = (
  context: SemanticFlowProjectionContext,
): void => {
  for (const binding of context.ir.bindings) {
    const bindingNode = context.bindingNodes.get(binding.bindingId);
    if (bindingNode === undefined) continue;
    projectValue({
      context,
      binding,
      value: binding.value,
      target: bindingNode,
      role: "binding",
    });
  }
};

interface ValueProjectionInput {
  readonly context: SemanticFlowProjectionContext;
  readonly binding: JavaScriptSemanticBinding;
  readonly value: JavaScriptSemanticValue;
  readonly target: ReturnType<typeof semanticPropertySlot>;
  readonly role: string;
}

const projectValue = (input: ValueProjectionInput): void => {
  const { context, binding, value, target, role } = input;
  if (target === null) return;
  if (value.status === "literal") {
    const literal = addLiteralNode(context, binding, value.value, role);
    addSemanticGraphRelation(context.state, {
      source: literal,
      target,
      relation: "defines",
      resolution: "resolved",
    });
  } else if (value.status === "union")
    for (const primitive of value.values) {
      const literal = addLiteralNode(context, binding, primitive, role);
      addSemanticGraphRelation(context.state, {
        source: literal,
        target,
        relation: "defines",
        resolution: "candidate",
      });
    }
  else if (value.status === "object")
    for (const property of value.properties) {
      const slot = semanticPropertySlot(
        context,
        binding.bindingId,
        property.name,
      );
      addSemanticGraphRelation(context.state, {
        source: target,
        target: slot,
        relation: "writes-property",
        resolution: value.unknownProperties ? "candidate" : "resolved",
      });
      projectValue({
        context,
        binding,
        value: property.value,
        target: slot,
        role: `property:${property.name}`,
      });
    }
};

const addLiteralNode = (
  context: SemanticFlowProjectionContext,
  binding: JavaScriptSemanticBinding,
  value: string | number | boolean | null,
  role: string,
) =>
  retainSemanticGraphNode(context.state, context.file, {
    kind: "literal",
    roleKey: `literal:${binding.bindingId}:${role}:${JSON.stringify(value)}`,
    location: binding.definitions[0]?.location ?? null,
    label: JSON.stringify(value),
    functionNodeId:
      context.bindingNodes.get(binding.bindingId)?.function_node_id ?? null,
    properties: { value },
  });

/** Create one canonical property slot for a binding/property identity. */
export const semanticPropertySlot = (
  context: SemanticFlowProjectionContext,
  objectBindingId: string,
  name: string,
) =>
  retainSemanticGraphNode(context.state, context.file, {
    kind: "property-slot",
    roleKey: `property:${objectBindingId}:${name}`,
    location: null,
    label: name,
    functionNodeId:
      context.bindingNodes.get(objectBindingId)?.function_node_id ?? null,
    properties: {
      name,
      object_binding_id: objectBindingId,
    } satisfies Readonly<Record<string, JsonValue>>,
  });
