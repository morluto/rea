import { z } from "zod";

import type { ToolContract } from "./toolContractTypes.js";
import { sanitizeWireInputSchema } from "./wireSchemaSanitizer.js";

const PROPERTY_DESCRIPTIONS: Readonly<Record<string, string>> = {
  addresses: "Ordered provider-normalized procedure addresses to analyze.",
  after: "The later or right-hand observation to compare.",
  before: "The earlier or left-hand observation to compare.",
  boundary_id: "Exact reconstruction boundary identifier to evaluate.",
  case_sensitive:
    "Whether text matching distinguishes uppercase and lowercase.",
  cdp_endpoint: "Literal loopback Chrome DevTools Protocol endpoint.",
  comment: "Exact analyst comment text to write.",
  comparisons: "Validated comparison Evidence records to aggregate.",
  coverage: "Exact reconstruction-coverage commitment to verify.",
  direction: "Direction in which to traverse or compare relationships.",
  document: "Exact provider document or program identity.",
  error: "Structured, caller-actionable error when the operation fails.",
  evidence: "Evidence record produced by this operation.",
  evidence_id: "Stable identifier of the recorded Evidence observation.",
  executable: "Command name or executable path to run.",
  format: "Declared input artifact format.",
  name: "Exact name used by this operation.",
  pattern:
    "Literal text or regular expression used to filter matching results.",
  phase: "Current plan or execution phase of the operation.",
  plan: "Content-bound execution plan and its digest commitment.",
  query: "Non-empty feature or text query to investigate.",
  question: "Concrete unresolved question to retain for later investigation.",
  result: "Primary structured result returned by this operation.",
  left: "Left-hand input used for comparison or differential execution.",
  limits:
    "Resource budgets that bound execution and retained output for this operation.",
  mode: "Operation mode that selects the requested behavior.",
  overwrite: "Whether an existing destination may be replaced.",
  path: "Local filesystem path used by this operation.",
  provider_id:
    "Exact deep-analysis provider ID, or automatic selection when omitted.",
  right: "Right-hand input used for comparison or differential execution.",
  source_evidence:
    "Evidence records supporting the prepared source transformation.",
  status: "Current lifecycle or verification status.",
  summary: "Concise evidence-backed summary of the result.",
  symbols: "Ordered Swift symbols to demangle.",
  target_id:
    "Exact CDP target identifier selected from the endpoint's target listing.",
  unknown_id: "Exact residual-unknown identifier.",
};

/** Attach caller guidance to a canonical schema for the SDK wire projection. */
export const toolInputSchemaWithMetadata = <Contract extends ToolContract>(
  contract: Contract,
): Contract["inputSchema"] => {
  const schema = contract.inputSchema.meta(
    z.globalRegistry.get(contract.inputSchema) ?? {},
  );
  const standard = schema["~standard"];
  const inputJsonSchema = standard.jsonSchema?.input;
  if (inputJsonSchema === undefined)
    throw new TypeError(
      "Tool input schema does not expose Standard JSON Schema",
    );

  // Zod's input projection drops root metadata when a descendant transforms.
  // Preserve the parser and let the SDK own conversion of everything else.
  // The wire projection is additionally sanitized so strict function-calling
  // clients can consume the tool catalog (#919); the canonical Zod contract
  // is untouched.
  Object.defineProperty(schema, "~standard", {
    value: {
      ...standard,
      jsonSchema: {
        ...standard.jsonSchema,
        input: (options: Parameters<typeof inputJsonSchema>[0]) => ({
          ...sanitizeWireInputSchema(
            describeProperties(inputJsonSchema(options)),
          ),
          examples: contract.examples.map(({ input }) => input),
        }),
      },
    },
  });
  return schema;
};

const describeProperties = (
  value: Readonly<Record<string, unknown>>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (key !== "properties" || !isObject(child))
        return [key, describeValue(child)];
      return [
        key,
        Object.fromEntries(
          Object.entries(child).map(([property, propertySchema]) => [
            property,
            isObject(propertySchema) &&
            typeof propertySchema.description !== "string"
              ? {
                  ...describeProperties(propertySchema),
                  description: fallbackPropertyDescription(property),
                }
              : describeValue(propertySchema),
          ]),
        ),
      ];
    }),
  );

const describeValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(describeValue);
  return isObject(value) ? describeProperties(value) : value;
};

const fallbackPropertyDescription = (property: string): string => {
  const explicit = PROPERTY_DESCRIPTIONS[property];
  if (explicit !== undefined) return explicit;
  const words = property.replaceAll("_", " ");
  if (property.startsWith("max_"))
    return `Maximum permitted ${words.slice(4)} for this operation.`;
  if (property.startsWith("include_"))
    return `Whether to include ${words.slice(8)} in the result.`;
  if (property.startsWith("expected_"))
    return `Expected ${words.slice(9)} used to reject stale or mismatched input.`;
  if (property.endsWith("_sha256"))
    return `Exact SHA-256 digest of ${words.slice(0, -7)}.`;
  if (property.endsWith("_evidence_id"))
    return `Exact Evidence identifier for the ${words.slice(0, -12)} observation.`;
  if (property.endsWith("_evidence_ids"))
    return `Ordered Evidence identifiers for the ${words.slice(0, -13)} observations.`;
  if (property.endsWith("_path"))
    return `Local filesystem path for ${words.slice(0, -5)}.`;
  if (property.endsWith("_uri"))
    return `Canonical URI for ${words.slice(0, -4)}.`;
  if (property.endsWith("_bytes"))
    return `Byte count for ${words.slice(0, -6)}.`;
  if (property.endsWith("_root") || property.endsWith("_roots"))
    return `Local filesystem ${words} selected for this operation.`;
  if (property.startsWith("is_") || property.startsWith("has_"))
    return `Whether ${words}.`;
  return `Value for ${words}.`;
};

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
