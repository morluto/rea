/** Primitive values admitted into the bounded constant lattice. */
export type JavaScriptSemanticPrimitive = string | number | boolean | null;

type JavaScriptSemanticObjectValue = {
  readonly status: "object";
  readonly properties: readonly JavaScriptSemanticProperty[];
} & (
  | {
      readonly unknownProperties: false;
      readonly omittedProperties: 0;
    }
  | {
      readonly unknownProperties: true;
      readonly omittedProperties: number | null;
    }
);

type JavaScriptSemanticArrayValue = {
  readonly status: "array";
  readonly items: readonly JavaScriptSemanticValue[];
} & (
  | {
      readonly unknownItems: false;
      readonly omittedItems: 0;
    }
  | {
      readonly unknownItems: true;
      readonly omittedItems: number | null;
    }
);

/** Bounded, execution-free value lattice for JavaScript expressions. */
export type JavaScriptSemanticValue =
  | {
      readonly status: "literal";
      readonly value: JavaScriptSemanticPrimitive;
    }
  | {
      readonly status: "union";
      readonly values: readonly JavaScriptSemanticPrimitive[];
    }
  | JavaScriptSemanticObjectValue
  | JavaScriptSemanticArrayValue
  | {
      readonly status: "unknown" | "ambiguous" | "cycle" | "limit-reached";
      readonly reason: string;
    };

/** One statically named object-literal property. */
export interface JavaScriptSemanticProperty {
  readonly name: string;
  readonly value: JavaScriptSemanticValue;
}
