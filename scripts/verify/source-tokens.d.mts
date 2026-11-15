export interface SourceToken {
  readonly kind: string;
  readonly text: string;
  readonly start: number;
}
export interface SourceComment {
  readonly text: string;
  readonly end: number;
}
export const expressionKeywords: ReadonlySet<string>;
export function tokenize(source: string): {
  tokens: SourceToken[];
  comments: SourceComment[];
};
