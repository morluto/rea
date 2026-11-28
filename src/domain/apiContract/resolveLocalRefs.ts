import { jsonPointerSyntaxProblem, jsonPointerTokens } from "../jsonPointer.js";
import { isRecord } from "../../kernel/isRecord.js";
import { Budget } from "../budget.js";
import { ellipsisExcerpt, quotedExcerpt } from "../excerpt.js";

/** Maximum $ref hops followed while resolving one local reference chain. */
export const API_CONTRACT_MAX_REF_DEPTH = 10;
/** Maximum local references resolved while parsing one document. */
export const API_CONTRACT_MAX_LOCAL_REF_EXPANSIONS = 256;

/**
 * Reference text kept in a failure detail. A chained $ref can be as long as
 * the input document, so details quote at most this many characters; the
 * full value is never copied into retained diagnostics.
 */
const DETAIL_REF_CHARS = 512;

/**
 * Per-document reference limits the resolver accepts. The parser uses the
 * defaults; a caller that owns a tighter or looser allowance passes its own.
 * Both ceilings are representation bounds: every resolved reference expands
 * the retained inventory against the retained-facts allowance, so the caps
 * bound expansion before allocation. There is no runtime setting for them;
 * the exhausted control and its recovery are reported in the failure detail.
 */
export interface LocalRefLimits {
  readonly maxRefDepth?: number;
  readonly maxLocalRefExpansions?: number;
}

export type LocalRefOutcome =
  | {
      readonly kind: "resolved";
      readonly target: Record<string, unknown>;
      /** The fragment (without "#") that identified the terminal target. */
      readonly pointer: string;
      /**
       * Every visited target, nearest first; the terminal target is last.
       * An intermediate target's own operations stay visible to the caller.
       */
      readonly chain: readonly {
        readonly pointer: string;
        readonly target: Record<string, unknown>;
      }[];
    }
  | { readonly kind: "cycle"; readonly detail: string }
  | { readonly kind: "missing-target"; readonly detail: string }
  | { readonly kind: "invalid-pointer"; readonly detail: string }
  | {
      readonly kind: "invalid-reference";
      readonly detail: string;
      /** The fragment (without "#") whose $ref is present but not a string. */
      readonly pointer: string;
    }
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
    // Only members the document declares: inherited properties such as
    // `__proto__` are not document members.
    if (!Object.hasOwn(current, token)) return undefined;
    current = (current as Record<string, unknown>)[token];
    if (current === undefined) return undefined;
  }
  return current;
};

/**
 * Percent-decode a URI fragment before JSON Pointer parsing (RFC 6901 §6):
 * `#/paths/~1users~1%7Bid%7D` names `/users/{id}`, not `/users/%7Bid%7D`.
 * Decoding runs before the pointer syntax check, so a decoded `~2` is still
 * an invalid escape.
 */
const decodeFragment = (
  fragment: string,
): { readonly pointer: string } | { readonly problem: string } => {
  try {
    return { pointer: decodeURIComponent(fragment) };
  } catch {
    return { problem: "its percent-escapes are malformed" };
  }
};

/**
 * Resolves local same-document $ref fragments (RFC 6901) against one parsed
 * document. Only "#/..." fragments are followed; anything else is reported
 * external and never fetched. No network fetch or external file read happens
 * here: resolution only walks the already-parsed document.
 */
export class LocalRefResolver {
  readonly #root: Record<string, unknown>;
  readonly #expansions: Budget;
  readonly #maxRefDepth: number;

  constructor(root: Record<string, unknown>, limits: LocalRefLimits = {}) {
    this.#root = root;
    this.#expansions = new Budget(
      limits.maxLocalRefExpansions ?? API_CONTRACT_MAX_LOCAL_REF_EXPANSIONS,
    );
    this.#maxRefDepth = limits.maxRefDepth ?? API_CONTRACT_MAX_REF_DEPTH;
  }

  /** Local references resolved so far in this document. */
  get expansions(): number {
    return this.#expansions.used;
  }

  resolve(ref: string): LocalRefOutcome {
    if (!ref.startsWith("#"))
      return {
        kind: "external",
        detail: `Local $ref ${quotedExcerpt(ref, DETAIL_REF_CHARS)} is not a same-document fragment; external references are never fetched.`,
      };
    const initial = decodeFragment(ref.slice(1));
    if ("problem" in initial)
      return {
        kind: "invalid-pointer",
        detail: `Local $ref ${quotedExcerpt(ref, DETAIL_REF_CHARS)} is not a valid JSON Pointer (${initial.problem}).`,
      };
    let pointer = initial.pointer;
    if (pointer === "")
      return {
        kind: "missing-target",
        detail: `Local $ref ${quotedExcerpt(ref, DETAIL_REF_CHARS)} refers to the whole document, not a Path Item.`,
      };
    const syntax = jsonPointerSyntaxProblem(pointer);
    if (syntax !== null)
      return {
        kind: "invalid-pointer",
        detail: `Local $ref ${quotedExcerpt(ref, DETAIL_REF_CHARS)} is not a valid JSON Pointer (${syntax}).`,
      };
    const visited = new Set<string>();
    const chain: { pointer: string; target: Record<string, unknown> }[] = [];
    let hops = 0;
    for (;;) {
      if (visited.has(pointer))
        return {
          kind: "cycle",
          detail: `Local $ref ${quotedExcerpt(ref, DETAIL_REF_CHARS)} forms a reference cycle at "#${ellipsisExcerpt(pointer, DETAIL_REF_CHARS)}".`,
        };
      visited.add(pointer);
      const target = lookupPointer(this.#root, pointer);
      if (target === undefined)
        return {
          kind: "missing-target",
          detail: `Local $ref ${quotedExcerpt(ref, DETAIL_REF_CHARS)} points at "#${ellipsisExcerpt(pointer, DETAIL_REF_CHARS)}", which does not exist in this document.`,
        };
      if (!isRecord(target))
        return {
          kind: "missing-target",
          detail: `Local $ref ${quotedExcerpt(ref, DETAIL_REF_CHARS)} points at "#${ellipsisExcerpt(pointer, DETAIL_REF_CHARS)}", which is not a Path Item object.`,
        };
      // A present but non-string $ref is malformed, not a terminal item:
      // accepting it would declare operations from an untrusted target.
      // The detail names only the target, so one malformed target yields
      // one diagnostic no matter how many references reach it.
      if (Object.hasOwn(target, "$ref")) {
        const next = target.$ref;
        if (typeof next !== "string")
          return {
            kind: "invalid-reference",
            detail: `The Path Item at "#${ellipsisExcerpt(pointer, DETAIL_REF_CHARS)}" has a $ref that is present but is not a string; references to it cannot be trusted.`,
            pointer,
          };
        if (hops >= this.#maxRefDepth)
          return {
            kind: "budget-exceeded",
            detail: `Local $ref ${quotedExcerpt(ref, DETAIL_REF_CHARS)} exceeds the reference depth budget of ${String(this.#maxRefDepth)} hops (api-contract-local-ref-depth); shorten the reference chain. The retained-facts allowance is unchanged.`,
          };
        if (!next.startsWith("#"))
          return {
            kind: "external",
            detail: `Local $ref ${quotedExcerpt(ref, DETAIL_REF_CHARS)} chains to ${quotedExcerpt(next, DETAIL_REF_CHARS)}, which is not a same-document fragment; external references are never fetched.`,
          };
        chain.push({ pointer, target });
        hops++;
        const chained = decodeFragment(next.slice(1));
        if ("problem" in chained)
          return {
            kind: "invalid-pointer",
            detail: `Local $ref ${quotedExcerpt(ref, DETAIL_REF_CHARS)} chains to ${quotedExcerpt(next, DETAIL_REF_CHARS)}, which is not a valid JSON Pointer (${chained.problem}).`,
          };
        pointer = chained.pointer;
        if (pointer === "")
          return {
            kind: "missing-target",
            detail: `Local $ref ${quotedExcerpt(ref, DETAIL_REF_CHARS)} chains to ${quotedExcerpt(next, DETAIL_REF_CHARS)}, which refers to the whole document, not a Path Item.`,
          };
        const chainedSyntax = jsonPointerSyntaxProblem(pointer);
        if (chainedSyntax !== null)
          return {
            kind: "invalid-pointer",
            detail: `Local $ref ${quotedExcerpt(ref, DETAIL_REF_CHARS)} chains to ${quotedExcerpt(next, DETAIL_REF_CHARS)}, which is not a valid JSON Pointer (${chainedSyntax}).`,
          };
        continue;
      }
      if (!this.#expansions.tryCharge(1))
        return {
          kind: "budget-exceeded",
          detail: `Local $ref ${quotedExcerpt(ref, DETAIL_REF_CHARS)} exceeds the local-reference expansion budget of ${String(this.#expansions.maximum)} resolved references per document (api-contract-local-ref-expansions); reduce the number of local $ref resolutions in the document. The retained-facts allowance is unchanged.`,
        };
      chain.push({ pointer, target });
      return { kind: "resolved", target, pointer, chain };
    }
  }
}
