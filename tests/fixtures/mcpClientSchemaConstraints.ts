import { geminiUnsupportedLiteral } from "../../scripts/lib/gemini-schema-literals.mjs";
import { clientSchemaPositions } from "../../scripts/lib/client-schema-positions.mjs";

/** VS Code Copilot rejects falsy `items` for any type that admits arrays. */
export const arrayItemSchemaError = (
  schema: unknown,
  path: string,
): string | undefined => {
  for (const position of clientSchemaPositions(schema)) {
    if (position.kind !== "schema") continue;
    const value = position.schema;
    const admitsArrays =
      value.type === "array" ||
      (Array.isArray(value.type) && value.type.includes("array"));
    if (admitsArrays && !value.items)
      return `${path}${position.path.slice(1)}: tool parameters array type must have items`;
  }
  return undefined;
};

/** Reject Gemini-incompatible boolean and empty-string input literals. */
export const unsupportedInputLiteralSchemaError = (
  schema: unknown,
  path: string,
): string | undefined => {
  const finding = geminiUnsupportedLiteral(schema);
  if (finding === undefined) return undefined;
  const reason =
    finding.reason === "boolean"
      ? finding.keyword === "const"
        ? "is boolean"
        : "contains a boolean"
      : finding.keyword === "const"
        ? "is an empty string"
        : "contains an empty string";
  return `${path}${finding.path.slice(1)} ${reason}`;
};
