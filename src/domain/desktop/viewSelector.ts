/**
 * One condition of a selector, equal to a value: a member's string field, with
 * `@` one of its attributes, or with `>` the text of a child element of its own.
 */
export interface Condition {
  readonly prefix: "" | "@" | ">";
  readonly key: string;
  readonly value: string;
}

export const bracketed = (segment: string) =>
  segment.length >= 2 && segment.startsWith("[") && segment.endsWith("]");

/** A segment's conditions when it is a selector; otherwise undefined. A value cannot hold `][`. */
export const selectorOf = (
  segment: string,
): readonly Condition[] | undefined => {
  if (!bracketed(segment)) return undefined;
  const conditions: Condition[] = [];
  for (const part of segment.slice(1, -1).split("][")) {
    const equals = part.indexOf("=");
    const key = equals < 0 ? "" : part.slice(0, equals);
    const prefix = key.startsWith("@") ? "@" : key.startsWith(">") ? ">" : "";
    const name = key.slice(prefix.length);
    if (name === "") return undefined;
    conditions.push({ prefix, key: name, value: part.slice(equals + 1) });
  }
  return conditions;
};
