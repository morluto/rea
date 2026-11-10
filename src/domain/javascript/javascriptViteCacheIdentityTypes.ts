import type * as t from "@babel/types";
import type { JavaScriptSemanticBindingState } from "./javascriptSemanticState.js";

type Initializer =
  JavaScriptSemanticBindingState["referenceInitializers"][number];
type Key = string | null;
export type VertexKey = t.Node | string | object;

export interface ViteCacheAllocation {
  readonly kind: "helper" | "cache" | "container" | "foreign";
  readonly owner?: string;
  readonly node?: t.Node;
  /** cache owners reachable through indexed array elements. */
  readonly elementFamily?: Vertex;
  readonly copy?: {
    readonly source: Vertex;
    readonly initializer: Initializer;
  };
  readonly helperResult?: {
    readonly table: Vertex;
    readonly keys: readonly (string | null | undefined)[];
    readonly unknownFrom: number | undefined;
    readonly read: t.Node;
    readonly family: Vertex;
  };
}

/** a single identity and a finite join of reachable cache owners. */
export interface ViteCacheIdentity {
  readonly allocation: ViteCacheAllocation | null;
  readonly owner: string | null | undefined;
  /** reachable children exclude the allocation itself, including cache roots. */
  readonly children?: string | null | undefined;
  /** A reachable value may be an inherited Array prototype or its constructor. */
  readonly inheritedArrayPrototype?: true;
  /** Shared prototype identities reachable through contained values. */
  readonly childrenInheritedArrayPrototype?: true;
  /** Intrinsic value that becomes exposed if selected by the helper. */
  readonly intrinsicPrototype?: true;
  /** exact built-in identity, retained separately from reachable prototypes. */
  readonly intrinsicObject?:
    | "Array"
    | "Object"
    | "Array.prototype"
    | "Object.prototype";
  readonly childrenIntrinsicPrototype?: true;
  /** This value is proven to be the shared intrinsic itself. */
  readonly exactPrototype?: true;
}

export interface Vertex {
  readonly key: VertexKey;
  readonly inputs: Input[];
  readonly listeners: Set<Vertex>;
  seed?: ViteCacheIdentity;
  fact?: ViteCacheIdentity;
}

export type Input =
  | {
      readonly kind: "default";
      readonly source: Vertex;
      readonly fallback: Vertex;
      readonly defined: boolean;
    }
  | {
      readonly kind: "helper-result";
      readonly source: Vertex;
      readonly call: t.CallExpression | t.OptionalCallExpression;
    }
  | {
      readonly kind:
        | "alias"
        | "family"
        | "mapped-family"
        | "copy-family"
        | "iteration-family";
      readonly source: Vertex;
      readonly read?: t.Node;
      readonly enumerableOnly?: boolean;
    }
  | {
      readonly kind: "copy-property";
      readonly source: Vertex;
      readonly receiver: Vertex;
      readonly target: NonNullable<ViteCacheIdentity["intrinsicObject"]>;
    }
  | {
      readonly kind: "prototype";
      readonly source: Vertex;
      readonly read: t.Node;
    }
  | {
      readonly kind: "select";
      readonly source: Vertex;
      readonly key: Key;
      readonly read: t.Node;
    }
  | {
      readonly kind: "inherited-selection";
      readonly source: Vertex;
      readonly key: string;
      readonly read: t.Node;
    };

/** Exposure can refer directly to an already normalized selected-table value. */
export type ViteCacheValue = t.Node | Vertex;

export interface ViteCacheExposure {
  readonly node: t.Node;
  readonly value: ViteCacheValue;
}

export interface ViteCacheWrite {
  readonly node: t.Node;
  readonly receiver: t.Node;
  readonly key: Key;
  readonly value?: t.Node;
  readonly propertySource?: t.ObjectExpression;
  /** undefined preserves the descriptor's unproven or existing enumerability. */
  readonly enumerable?: boolean | undefined;
}

export const FOREIGN: ViteCacheIdentity = {
  allocation: { kind: "foreign" },
  owner: undefined,
};
export const UNKNOWN: ViteCacheIdentity = {
  allocation: null,
  owner: undefined,
};
