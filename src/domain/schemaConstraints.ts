import { z } from "zod";

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
    if (rule.equals === undefined) {
      (dependentRequired[rule.when] ??= []).push(rule.requires);
      continue;
    }
    conditionals.push({
      if: {
        properties: { [rule.when]: { const: rule.equals } },
        required: [rule.when],
      },
      then: { required: [rule.requires] },
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
 * rule keyed on a value, `if`/`then`. Issues follow the rule order.
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
          value[rule.requires] !== undefined
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
