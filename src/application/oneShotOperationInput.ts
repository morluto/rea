import type { z } from "zod";
import { toolContract } from "../contracts/toolContracts.js";
import { OFFICIAL_TOOL_CONTRACTS } from "../contracts/officialToolContracts.js";
import { NATIVE_TOOL_CONTRACTS } from "../contracts/native/nativeToolContracts.js";
import {
  ARTIFACT_TOOL_CONTRACTS,
  artifactInventoryInputSchema,
  type ArtifactAnalysisOperation,
} from "../contracts/artifactToolContracts.js";
import {
  MANAGED_TOOL_CONTRACTS,
  managedArtifactInputSchema,
  managedMembersInputSchema,
  type ManagedToolName,
} from "../contracts/managed/managedToolContracts.js";
import { enhancedInputSchemas } from "../contracts/enhancedInputs.js";
import type { NativeToolName } from "../contracts/native/nativeToolContracts.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { parseAnalysisInput } from "./AnalysisInput.js";
import { ok } from "../domain/result.js";

/** Operations the direct workflow can perform without a persistent session. */
export type DirectAnalysisTool =
  | "annotate_native_function"
  | "inspect_native_load_image"
  | "read_bytes"
  | "search_bytes"
  | "address_to_file_offset"
  | "binary_overview"
  | "procedure_pseudo_code"
  | "procedure_references"
  | "read_function_instructions"
  | "inspect_native_instruction"
  | "inspect_native_data_type"
  | "resolve_native_call_targets"
  | "analyze_function"
  | "inspect_native_api"
  | "inspect_native_dispatch_metadata"
  | "search_strings"
  | "search_procedures"
  | "xrefs"
  | "trace_feature"
  | "trace_native_ui_action"
  | "trace_native_values"
  | "decompile_all";

type OneShotOperation =
  | DirectAnalysisTool
  | NativeToolName
  | ArtifactAnalysisOperation
  | ManagedToolName;
type Schema = z.ZodType<Readonly<Record<string, unknown>>>;

type ContractSchemas<
  Contracts extends readonly {
    readonly name: string;
    readonly inputSchema: Schema;
  }[],
> = {
  [Contract in Contracts[number] as Contract["name"]]: Contract["inputSchema"];
};

const schemasByName = <
  const Contracts extends readonly {
    readonly name: string;
    readonly inputSchema: Schema;
  }[],
>(
  contracts: Contracts,
): ContractSchemas<Contracts> =>
  Object.fromEntries(
    contracts.map(({ name, inputSchema }) => [name, inputSchema]),
  ) as ContractSchemas<Contracts>;

const schemas = {
  ...schemasByName(OFFICIAL_TOOL_CONTRACTS),
  ...schemasByName(NATIVE_TOOL_CONTRACTS),
  ...schemasByName(ARTIFACT_TOOL_CONTRACTS),
  ...schemasByName(MANAGED_TOOL_CONTRACTS),
  ...enhancedInputSchemas,
  inspect_native_load_image: toolContract(
    "inspect_native_load_image",
  ).inputSchema.omit({ detail: true }),
  inspect_managed_artifact: managedArtifactInputSchema.omit({ detail: true }),
  inspect_managed_members: managedMembersInputSchema.omit({ detail: true }),
  inventory_artifact: artifactInventoryInputSchema,
} satisfies Record<OneShotOperation, Schema>;

/** Parse the named operation before target selection or snapshot replay. */
export const admitOneShotOperation = <Name extends OneShotOperation>(
  name: Name,
  input: Readonly<Record<string, JsonValue>>,
  signal?: AbortSignal,
) => {
  type SelectedInput = Partial<z.output<(typeof schemas)[Name]>> &
    Readonly<Record<string, JsonValue>>;
  const parsed = parseAnalysisInput(
    name,
    input,
    schemas[name] as Schema,
    signal,
  );
  if (!parsed.ok) return parsed;
  // Admission owns the selected request: preserve top-level omissions for
  // Evidence and snapshot identity while carrying each selected parsed value.
  // Nested defaults remain in the owning field's parsed value.
  const selected = Object.fromEntries(
    Object.entries(parsed.value).filter(([key]) => Object.hasOwn(input, key)),
  ) as SelectedInput;
  return ok({ name, input: selected });
};
