/**
 * One condition of a selector, equal to a value: a member's string field, with
 * `@` one of its attributes, or with `>` what a path of steps inside it holds
 * (`insideSteps`).
 */
export interface Condition {
  readonly prefix: "" | "@" | ">";
  readonly key: string;
  readonly value: string;
}

/** The most `/`-separated steps a `>` condition's path takes into a member. */
export const MAX_INSIDE_STEPS = 3;

/** A `>` condition's path as its steps; undefined when one is empty or there are more than `MAX_INSIDE_STEPS`. */
export const insideSteps = (key: string): readonly string[] | undefined => {
  const steps = key.split("/");
  return steps.length <= MAX_INSIDE_STEPS && !steps.includes("")
    ? steps
    : undefined;
};

/** Whether a selector condition reads the supplied JSON field path. */
export const conditionReadsField = (
  condition: Condition,
  tokens: readonly string[],
): boolean => {
  if (condition.prefix === "@") return false;
  if (condition.prefix === "")
    return tokens.length === 1 && tokens[0] === condition.key;
  const steps = insideSteps(condition.key);
  return (
    steps !== undefined &&
    steps.length === tokens.length &&
    steps.every((step, index) => step === tokens[index])
  );
};

/** A condition as a selector spells it, such as `[@Col=3]`. */
export const spellCondition = ({ prefix, key, value }: Condition) =>
  `[${prefix}${key}=${value}]`;

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
    if (name === "" || (prefix === ">" && insideSteps(name) === undefined))
      return undefined;
    conditions.push({ prefix, key: name, value: part.slice(equals + 1) });
  }
  return conditions;
};
