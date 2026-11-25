import { jsonPointerSyntaxProblem, jsonPointerTokens } from "../jsonPointer.js";
import { isRecord } from "../../kernel/isRecord.js";

/** Maximum $ref hops followed while resolving one local reference chain. */
export const API_CONTRACT_MAX_REF_DEPTH = 10;
/** Maximum local references resolved while parsing one document. */
export const API_CONTRACT_MAX_LOCAL_REF_EXPANSIONS = 256;

export type LocalRefOutcome =
  | {
      readonly kind: "resolved";
      readonly target: Record<string, unknown>;
      /** The fragment (without "#") that identified the terminal target. */
      readonly pointer: string;
    }
  | { readonly kind: "cycle"; readonly detail: string }
  | { readonly kind: "missing-target"; readonly detail: string }
  | { readonly kind: "invalid-pointer"; readonly detail: string }
  | { readonly kind: "external"; readonly detail: string }
  | { readonly kind: "budget-exceeded"; readonly detail: string };

const lookupPointer = (
  root: Record<string, unknown>,
  pointer: string,
): unknown => {
  if (pointer === "") return root;
  let current: unknown = root;
  for (const token of jsonPointerTokens(pointer)) {
    if (!isRecord(current) && !Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[token];
    if (current === undefined) return undefined;
  }
  return current;
};

/**
 * Resolves local same-document $ref fragments (RFC 6901) against one parsed
 * document. Only "#/..." fragments are followed; anything else is reported
 * external and never fetched. No network fetch or external file read happens
 * here: resolution only walks the already-parsed document.
 */
export class LocalRefResolver {
  readonly #root: Record<string, unknown>;
  #expansions = 0;

  constructor(root: Record<string, unknown>) {
    this.#root = root;
  }

  /** Local references resolved so far in this document. */
  get expansions(): number {
    return this.#expansions;
  }

  resolve(ref: string): LocalRefOutcome {
    if (!ref.startsWith("#"))
      return {
        kind: "external",
        detail: `Local $ref "${ref}" is not a same-document fragment; external references are never fetched.`,
      };
    let pointer = ref.slice(1);
    if (pointer === "")
      return {
        kind: "missing-target",
        detail: `Local $ref "${ref}" refers to the whole document, not a Path Item.`,
      };
    const syntax = jsonPointerSyntaxProblem(pointer);
    if (syntax !== null)
      return {
        kind: "invalid-pointer",
        detail: `Local $ref "${ref}" is not a valid JSON Pointer (${syntax}).`,
      };
    const visited = new Set<string>();
    let hops = 0;
    for (;;) {
      if (visited.has(pointer))
        return {
          kind: "cycle",
          detail: `Local $ref "${ref}" forms a reference cycle at "#${pointer}".`,
        };
      visited.add(pointer);
      const target = lookupPointer(this.#root, pointer);
      if (target === undefined)
        return {
          kind: "missing-target",
          detail: `Local $ref "${ref}" points at "#${pointer}", which does not exist in this document.`,
        };
      if (!isRecord(target))
        return {
          kind: "missing-target",
          detail: `Local $ref "${ref}" points at "#${pointer}", which is not a Path Item object.`,
        };
      const next = target.$ref;
      if (typeof next !== "string") {
        if (this.#expansions >= API_CONTRACT_MAX_LOCAL_REF_EXPANSIONS)
          return {
            kind: "budget-exceeded",
            detail: `Local $ref "${ref}" exceeds the expansion budget of ${API_CONTRACT_MAX_LOCAL_REF_EXPANSIONS} resolved references per document.`,
          };
        this.#expansions++;
        return { kind: "resolved", target, pointer };
      }
      if (hops >= API_CONTRACT_MAX_REF_DEPTH)
        return {
          kind: "budget-exceeded",
          detail: `Local $ref "${ref}" exceeds the reference depth budget of ${API_CONTRACT_MAX_REF_DEPTH} hops.`,
        };
      if (!next.startsWith("#"))
        return {
          kind: "external",
          detail: `Local $ref "${ref}" chains to "${next}", which is not a same-document fragment; external references are never fetched.`,
        };
      hops++;
      pointer = next.slice(1);
      if (pointer === "")
        return {
          kind: "missing-target",
          detail: `Local $ref "${ref}" chains to "${next}", which refers to the whole document, not a Path Item.`,
        };
      const chainedSyntax = jsonPointerSyntaxProblem(pointer);
      if (chainedSyntax !== null)
        return {
          kind: "invalid-pointer",
          detail: `Local $ref "${ref}" chains to "${next}", which is not a valid JSON Pointer (${chainedSyntax}).`,
        };
    }
  }
}
