import type {
  StandardSchemaV1,
  StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import type { ToolContract } from "../contracts/toolContractTypes.js";
import type { z } from "zod";
import {
  getEvidenceInputContract,
  type EvidenceRequestFrameInput,
} from "../domain/evidenceInputContract.js";
import {
  toolInputSchemaWithMetadata,
  toolOutputSchemaWithMetadata,
} from "../contracts/toolSchemaMetadata.js";
import {
  canReferenceInlineEvidence,
  markEvidenceInput,
} from "./evidenceInputRegistration.js";

/** One registration's SDK argument-element allowance. */
export interface StructuredArgumentCapacity {
  readonly tool: string;
  readonly maximumElements: number;
}

/** Parse structured argument text a client serialized instead of sending as JSON. */
const structuredArgumentText = (supplied: unknown): unknown => {
  if (typeof supplied !== "string") return supplied;
  if (!supplied.startsWith("{") && !supplied.startsWith("[")) return supplied;
  // The request-size limit bounds decoding. The element allowance bounds the
  // decoded graph before canonical validation.
  try {
    const parsed: unknown = JSON.parse(supplied);
    if (parsed !== null && typeof parsed === "object") return parsed;
  } catch {
    // Not JSON text: the supplied value keeps its meaning.
  }
  return supplied;
};

/** Merge JSON-text arguments into the bag; undefined when nothing needs recovery. */
const recoveredArgumentBag = (
  value: unknown,
): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const suppliedArguments = value as Record<string, unknown>;
  const recovered = new Map<string, unknown>();
  for (const [argument, supplied] of Object.entries(suppliedArguments)) {
    const parsed = structuredArgumentText(supplied);
    if (parsed !== supplied) recovered.set(argument, parsed);
  }
  return recovered.size === 0
    ? undefined
    : { ...suppliedArguments, ...Object.fromEntries(recovered) };
};

/**
 * Count array elements and object members exactly as the SDK's admission does.
 * Stop once the allowance is exceeded so counting cannot outrun the bound.
 */
const inputElementCount = (value: unknown, maximum: number): number => {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (const child of node) {
        if (++count > maximum) return count;
        if (child !== null && typeof child === "object") stack.push(child);
      }
    } else {
      for (const key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
        if (++count > maximum) return count;
        const child = (node as Record<string, unknown>)[key];
        if (child !== null && typeof child === "object") stack.push(child);
      }
    }
  }
  return count;
};

/** The SDK's pre-validation refusal text, so delivery keeps its typed error. */
const inputCapacityRefusal = ({
  tool,
  maximumElements,
}: StructuredArgumentCapacity): ProtocolError =>
  new ProtocolError(
    ProtocolErrorCode.InvalidParams,
    `Invalid arguments for tool ${tool}: arguments contain more than the maximum of ${String(maximumElements)} elements`,
  );

/** Whether recovery expanded the argument bag past the selected allowance. */
const refuseRecoveredArguments = (
  recoveredArguments: Record<string, unknown>,
  capacity: StructuredArgumentCapacity | undefined,
): void => {
  if (capacity === undefined || !Number.isFinite(capacity.maximumElements))
    return;
  if (
    inputElementCount(recoveredArguments, capacity.maximumElements) >
    capacity.maximumElements
  )
    throw inputCapacityRefusal(capacity);
};

/**
 * Pair a rejected recovered bag with the issues it produced so input-error
 * projection walks the rejected structure rather than the caller's JSON text.
 */
const rejectedInputs = new WeakMap<
  readonly StandardSchemaV1.Issue[],
  Record<string, unknown>
>();

/** The recovered arguments behind these issues, when recovery produced them. */
export const rejectedInputForIssues = (
  issues: readonly StandardSchemaV1.Issue[],
): unknown => rejectedInputs.get(issues);

/** Bound application registrations that recover their arguments in their own wrapper. */
const enforceRecoveredArgumentCapacity = (
  schema: StandardSchemaWithJSON,
  capacity: StructuredArgumentCapacity,
): StandardSchemaWithJSON => {
  const standard = schema["~standard"];
  return {
    "~standard": {
      ...standard,
      validate: (value: unknown) => {
        const recoveredArguments = recoveredArgumentBag(value);
        if (recoveredArguments !== undefined)
          refuseRecoveredArguments(recoveredArguments, capacity);
        return standard.validate(value);
      },
    },
  };
};

/**
 * Recover structured arguments a client delivered as JSON text before the
 * canonical parser runs. Claude Desktop serializes array and object arguments
 * to strings (morluto/rea#3408), so structured parameters are rejected.
 * Recovered values still face the canonical parser: JSON text a string
 * parameter accepts stays the caller's, malformed text keeps its validation
 * failure, and native JSON values are untouched. Recovery applies to the whole
 * argument bag, so a call that mixes recovered structured arguments with JSON
 * text a string parameter accepts keeps its rejection. When a capacity is
 * selected, the decoded bag is charged against it before canonical validation
 * so JSON text cannot bypass the native argument allowance.
 */
export const acceptStringifiedStructuredArguments = (
  schema: StandardSchemaWithJSON,
  capacity?: StructuredArgumentCapacity,
): StandardSchemaWithJSON => {
  const standard = schema["~standard"];
  if (standard === undefined || typeof standard.validate !== "function")
    return schema;
  if (standard.vendor === "rea-application")
    return capacity === undefined
      ? schema
      : enforceRecoveredArgumentCapacity(schema, capacity);
  const select = (
    parsedResult: Awaited<ReturnType<typeof standard.validate>>,
    value: unknown,
    recoveredArguments: Record<string, unknown>,
  ) => {
    if (parsedResult.issues === undefined) return parsedResult;
    rejectedInputs.set(parsedResult.issues, recoveredArguments);
    const unchangedResult = standard.validate(value);
    if (unchangedResult instanceof Promise) {
      return unchangedResult.then((result) =>
        "issues" in result ? parsedResult : result,
      );
    }
    return "issues" in unchangedResult ? parsedResult : unchangedResult;
  };
  return {
    "~standard": {
      ...standard,
      validate: (value: unknown) => {
        const recoveredArguments = recoveredArgumentBag(value);
        if (recoveredArguments === undefined) return standard.validate(value);
        // Charge the decoded graph before the canonical parser sees it.
        refuseRecoveredArguments(recoveredArguments, capacity);
        const parsedResult = standard.validate(recoveredArguments);
        return parsedResult instanceof Promise
          ? parsedResult.then((result) =>
              select(result, value, recoveredArguments),
            )
          : select(parsedResult, value, recoveredArguments);
      },
    },
  };
};

/** Project the canonical Zod contracts directly into SDK registration. */
export const toolRegistrationOptions = <Contract extends ToolContract>(
  contract: Contract,
): {
  readonly title: Contract["title"];
  readonly description: Contract["description"];
  readonly inputSchema: StandardSchemaWithJSON<
    z.input<Contract["inputSchema"]>,
    EvidenceRequestFrameInput<z.output<Contract["inputSchema"]>>
  >;
  readonly outputSchema: Contract["outputSchema"];
  readonly annotations: Contract["annotations"];
} => {
  const advertised = toolInputSchemaWithMetadata(contract);
  const evidenceInputs = getEvidenceInputContract<Contract["inputSchema"]>(
    contract.inputSchema,
  );
  // The application owns source admission. Preserve the exact advertised
  // declaration while the SDK validates only the borrowing request envelope.
  const inputSchema = {
    "~standard": {
      version: advertised["~standard"].version,
      vendor: advertised["~standard"].vendor,
      jsonSchema: advertised["~standard"].jsonSchema,
      validate: evidenceInputs.frameSchema["~standard"].validate,
    },
  };
  return {
    title: contract.title,
    description: contract.description,
    inputSchema: evidenceInputs.hasEvidenceReferenceAlternative
      ? markEvidenceInput(inputSchema)
      : inputSchema,
    outputSchema: toolOutputSchemaWithMetadata(contract),
    annotations: contract.annotations,
  };
};

/** Register a workflow that validates raw input before effects and projects its own errors. */
export const applicationToolRegistrationOptions = <
  Contract extends ToolContract,
>(
  contract: Contract,
) => {
  const registration = toolRegistrationOptions(contract);
  const standard = registration.inputSchema["~standard"];
  const inputSchema: StandardSchemaWithJSON = {
    "~standard": {
      ...standard,
      vendor: "rea-application",
      validate: async (value: unknown) => {
        const recoveredArguments = recoveredArgumentBag(value);
        if (recoveredArguments !== undefined) {
          const recoveredResult = await standard.validate(recoveredArguments);
          if (!("issues" in recoveredResult))
            return { value: recoveredArguments };
        }
        // The handler owns application parsing, so the wrapper always accepts.
        return { value };
      },
    },
  };
  return {
    ...registration,
    inputSchema: canReferenceInlineEvidence(registration.inputSchema)
      ? markEvidenceInput(inputSchema)
      : inputSchema,
  };
};
