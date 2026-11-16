import { z } from "zod";

import { annotatePatternDeclaration } from "./schemaAnnotations.js";

// Constraints Zod has no native check for. Each helper adds the runtime check
// and the JSON Schema keyword that declares it in one place, so every JSON
// Schema projection states exactly what parsing enforces.

type Primitive = string | number | boolean;

/** Reject repeated items; declared as `uniqueItems`. */
export const distinctItems = <Schema extends z.ZodArray<z.ZodType<Primitive>>>(
  schema: Schema,
  message: string,
): Schema =>
  schema
    .refine((items) => new Set(items).size === items.length, { message })
    .meta({ uniqueItems: true });

/** Reject these exact values; declared as `not: { enum }`. */
export const excludedValues = <Schema extends z.ZodType<Primitive>>(
  schema: Schema,
  values: readonly Primitive[],
  message: string,
): Schema =>
  schema
    .refine((value) => !values.includes(value), { message })
    .meta({ not: { enum: [...values] } });

/**
 * Bound a string by Unicode code points, the unit JSON Schema `maxLength`
 * counts; Zod's `.max()` counts UTF-16 code units. Aborts on failure, so later
 * checks never see an oversized value.
 */
export const maxCodePoints = (
  schema: z.ZodString,
  maximum: number,
  message: string,
): z.ZodString =>
  schema
    .refine(
      (value) => {
        const characters = value[Symbol.iterator]();
        for (let count = 0; count <= maximum; count += 1)
          if (characters.next().done) return true;
        return false;
      },
      { message, abort: true },
    )
    .meta({ maxLength: maximum });

/** One property whose presence requires another. */
export interface PresenceRule<Field extends string> {
  /** The property that, when present, triggers the rule. */
  readonly when: Field;
  /** Trigger only when `when` holds exactly this value. */
  readonly equals?: Primitive;
  readonly requires: Field;
  /** The required property must hold exactly this value. */
  readonly requiresValue?: Primitive;
  readonly message: string;
  /** Issue path; defaults to `when`. */
  readonly path?: Field;
}

type Declaration = Record<string, unknown>;

const declarePresence = (
  rules: readonly PresenceRule<string>[],
): Declaration => {
  const dependentRequired: Record<string, string[]> = {};
  const conditionals: Declaration[] = [];
  for (const rule of rules) {
    if (rule.equals === undefined && rule.requiresValue === undefined) {
      (dependentRequired[rule.when] ??= []).push(rule.requires);
      continue;
    }
    conditionals.push({
      if: {
        ...(rule.equals === undefined
          ? {}
          : { properties: { [rule.when]: { const: rule.equals } } }),
        required: [rule.when],
      },
      then: {
        required: [rule.requires],
        ...(rule.requiresValue === undefined
          ? {}
          : { properties: { [rule.requires]: { const: rule.requiresValue } } }),
      },
    });
  }
  return {
    ...(Object.keys(dependentRequired).length === 0
      ? {}
      : { dependentRequired }),
    ...(conditionals.length === 1
      ? conditionals[0]
      : conditionals.length > 1
        ? { allOf: conditionals }
        : {}),
  };
};

/**
 * Require properties together; declared as `dependentRequired` and, for a
 * rule keyed on a value or requiring one, `if`/`then`. Issues follow the
 * rule order.
 */
export const requirePresence = <
  Schema extends z.ZodObject,
  Field extends keyof z.output<Schema> & string,
>(
  schema: Schema,
  rules: readonly PresenceRule<Field>[],
): Schema =>
  schema
    .superRefine((parsed, context) => {
      const value = parsed as Record<string, unknown>;
      for (const rule of rules) {
        const trigger = value[rule.when];
        if (
          trigger === undefined ||
          (rule.equals !== undefined && trigger !== rule.equals) ||
          (rule.requiresValue === undefined
            ? value[rule.requires] !== undefined
            : value[rule.requires] === rule.requiresValue)
        )
          continue;
        context.addIssue({
          code: "custom",
          path: [rule.path ?? rule.when],
          message: rule.message,
        });
      }
    })
    .meta(declarePresence(rules));

/** Patterns that declare a string predicate JSON Schema cannot state directly. */
export interface PatternDeclaration {
  /** Patterns every accepted string matches. */
  readonly matches?: readonly RegExp[];
  /** Patterns no accepted string matches. */
  readonly excludes?: readonly RegExp[];
  /**
   * `exact` when the patterns accept exactly what `predicate` does; `wider`
   * when `predicate` also rejects strings the patterns admit.
   */
  readonly relation: "exact" | "wider";
}

/** A pattern JSON Schema states with the same meaning: no flag but `u`. */
const declaredPattern = (expression: RegExp): string => {
  if (expression.flags !== "" && expression.flags !== "u")
    throw new TypeError(
      `Pattern /${expression.source}/${expression.flags} has flags JSON Schema cannot declare`,
    );
  return expression.source;
};

/**
 * Check a predicate or canonical regex and declare its pattern-only wire
 * form. A regex keeps Zod's format issue rather than becoming a custom issue.
 */
export const declaredByPatterns = <Schema extends z.ZodString>(
  schema: Schema,
  predicate: ((value: string) => boolean) | RegExp,
  declaration: PatternDeclaration,
  check: { readonly message: string; readonly abort?: boolean },
): Schema => {
  const allOf = [
    ...(declaration.matches ?? []).map((expression) => ({
      pattern: declaredPattern(expression),
    })),
    ...(declaration.excludes ?? []).map((expression) => ({
      not: { pattern: declaredPattern(expression) },
    })),
  ];
  // An empty `allOf` is invalid JSON Schema and declares nothing.
  if (allOf.length === 0)
    throw new TypeError("A pattern declaration needs at least one pattern");
  return annotatePatternDeclaration(
    (predicate instanceof RegExp
      ? schema.regex(predicate, check)
      : schema.refine(predicate, check)
    ).meta({ allOf }) as Schema,
    declaration.relation,
  );
};

/**
 * Declare text as a JSON document, with the schema its decoded content
 * follows when one is known. JSON Schema's `content*` keywords annotate a
 * string rather than assert it, so the parse adds no check; the consumer that
 * decodes the text admits its content with the owning schema.
 */
export const jsonDocumentText = <Schema extends z.ZodString>(
  schema: Schema,
  contentSchema?: Record<string, unknown>,
): Schema =>
  schema.meta({
    contentMediaType: "application/json",
    ...(contentSchema === undefined ? {} : { contentSchema }),
  });
