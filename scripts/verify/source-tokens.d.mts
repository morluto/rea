export interface SourceToken {
  readonly kind: string;
  readonly text: string;
  readonly start: number;
  /** An expression keyword such as `return`, not a property name. */
  keyword?: true;
  /** The `}` that closes a statement block rather than an object literal. */
  closesBlock?: true;
  /** The `)` that closes a control head such as `if (…)`. */
  controlHead?: true;
  /** A postfix `!` (TypeScript non-null assertion) after a completed operand. */
  nonNullAssertion?: true;
  /** Template text that opens a `${` substitution. */
  readonly opensSubstitution?: true;
}
export interface SourceComment {
  readonly text: string;
  readonly end: number;
}
export function blankComments(
  source: string,
  comments?: readonly SourceComment[],
): string;
export function tokenize(source: string): {
  tokens: SourceToken[];
  comments: SourceComment[];
};
