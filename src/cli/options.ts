import { z } from "zod";

import { declaredTokenPattern } from "../domain/schemaConstraints.js";
import { decimalTokenPattern } from "./decimalTokenPattern.js";

/** Decimal integer argv text. Leading zeros stay decimal; `0x` and exponent spellings do not. */
const DECIMAL_INTEGER_TOKEN = /^[0-9]+$/u;

type DecimalWrapper =
  | { readonly kind: "default"; readonly value: number | null }
  | { readonly kind: "prefault"; readonly value: number | null }
  | {
      readonly kind: "optional" | "exactOptional" | "nullable" | "readonly";
    };

/** A number field, or a set of non-negative integer literals such as Rizin's widths. */
type NumericCore = z.ZodNumber | z.ZodLiteral<number>;

export const isNumericCore = (field: z.ZodType): field is NumericCore =>
  field instanceof z.ZodNumber ||
  (field instanceof z.ZodLiteral &&
    [...field.values].every(
      (value) =>
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    ));

/** The decimal tokens of a literal set, so `--schema` admits only its members. */
const literalTokenGrammar = (
  domain: z.ZodLiteral<number>,
): { readonly pattern: RegExp; readonly message: string } => {
  const members = [...domain.values];
  return {
    pattern: new RegExp(`^0*(?:${members.join("|")})$`, "u"),
    message: `Expected one of ${members.join(", ")}`,
  };
};

const tokenGrammar = (domain: NumericCore) => {
  if (domain instanceof z.ZodNumber)
    return declaredTokenPattern(
      z.string().regex(DECIMAL_INTEGER_TOKEN, "Expected a decimal integer"),
      new RegExp(decimalTokenPattern(domain), "u"),
    );
  const { pattern, message } = literalTokenGrammar(domain);
  return z.string().regex(pattern, message);
};

const decimalToken = (domain: NumericCore) =>
  tokenGrammar(domain).pipe(z.coerce.number<string>()).pipe(domain);

const unwrapSchema = (field: { unwrap: () => unknown }): z.ZodType =>
  field.unwrap() as z.ZodType;

/**
 * Command schemas advertise Zod's output view. Publish the input view so an argv token
 * grammar that transforms text survives `--schema` and other SDK conversions.
 */
export const publishArgvInput = <Field extends z.ZodType>(
  field: Field,
): Field => {
  const { $schema: _dialect, ...inputSchema } = z.toJSONSchema(field, {
    io: "input",
  });
  return field.meta(inputSchema);
};

const numericStack = (
  field: z.ZodType,
):
  | {
      readonly core: NumericCore;
      readonly wrappers: readonly DecimalWrapper[];
      readonly description: string | undefined;
    }
  | undefined => {
  const wrappers: DecimalWrapper[] = [];
  let description: string | undefined;
  let current = field;
  for (;;) {
    if (description === undefined && current.description !== undefined)
      description = current.description;
    if (current instanceof z.ZodDefault) {
      wrappers.push({
        kind: "default",
        value: current.parse(undefined) as number | null,
      });
      current = unwrapSchema(current);
      continue;
    }
    if (current instanceof z.ZodPrefault) {
      wrappers.push({
        kind: "prefault",
        value: current.parse(undefined) as number | null,
      });
      current = unwrapSchema(current);
      continue;
    }
    if (current instanceof z.ZodOptional) {
      wrappers.push({ kind: "optional" });
      current = unwrapSchema(current);
      continue;
    }
    if (current instanceof z.ZodExactOptional) {
      wrappers.push({ kind: "exactOptional" });
      current = unwrapSchema(current);
      continue;
    }
    if (current instanceof z.ZodNullable) {
      wrappers.push({ kind: "nullable" });
      current = unwrapSchema(current);
      continue;
    }
    if (current instanceof z.ZodReadonly) {
      wrappers.push({ kind: "readonly" });
      current = unwrapSchema(current);
      continue;
    }
    break;
  }
  return isNumericCore(current)
    ? { core: current, wrappers, description }
    : undefined;
};

const applyDecimalWrappers = (
  field: z.ZodType,
  wrappers: readonly DecimalWrapper[],
): z.ZodType => {
  let admitted = field;
  for (const wrapper of wrappers.toReversed()) {
    if (wrapper.kind === "nullable") admitted = admitted.nullable();
    else if (wrapper.kind === "optional") admitted = admitted.optional();
    else if (wrapper.kind === "exactOptional")
      admitted = admitted.exactOptional();
    else if (wrapper.kind === "readonly") admitted = admitted.readonly();
    else if (wrapper.kind === "prefault")
      admitted = admitted.prefault(wrapper.value as never);
    else if (wrapper.kind === "default")
      admitted = admitted.default(wrapper.value as never);
  }
  return admitted;
};

/**
 * Parse a decimal token, then let the domain field own bounds, defaults,
 * nullability and help. JSON numbers remain valid for schema consumers.
 */
export const cliDecimalField = <Field extends z.ZodType>(
  field: Field,
): z.ZodType<z.output<Field>> => {
  const numeric = numericStack(field);
  if (numeric === undefined)
    throw new Error(
      `cliDecimalField expected a numeric domain field, received ${field.constructor.name}`,
    );
  const branches = [numeric.core, decimalToken(numeric.core)] as const;
  // Both branches reject a non-member of a literal set, and incur reports
  // only the union issue, so the union names the members.
  const admitted = applyDecimalWrappers(
    numeric.core instanceof z.ZodLiteral
      ? z.union(branches, {
          error: literalTokenGrammar(numeric.core).message,
        })
      : z.union(branches),
    numeric.wrappers,
  );
  const described =
    numeric.description === undefined
      ? admitted
      : admitted.describe(numeric.description);
  return publishArgvInput(described) as z.ZodType<z.output<Field>>;
};

/** Adapt each numeric property of a shared shape; other properties stay unchanged. */
export const cliDecimalShape = <Shape extends Record<string, z.ZodType>>(
  shape: Shape,
): Shape =>
  Object.fromEntries(
    Object.entries(shape).map(([key, field]) => [
      key,
      numericStack(field) === undefined ? field : cliDecimalField(field),
    ]),
  ) as Shape;
