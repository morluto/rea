import type { AnalysisOperation } from "../application/AnalysisProvider.js";
import { KUNA_PROVIDER_ID } from "./KunaRelease.js";

/** Static identity; the observed Kuna release is reported in each analysis profile. */
export const KUNA_PROVIDER_IDENTITY = Object.freeze({
  id: KUNA_PROVIDER_ID,
  name: "Kuna",
  version: null,
});

/** Analyst outcomes Kuna's inventory and project export can answer. */
export const KUNA_OPERATIONS = Object.freeze([
  "list_documents",
  "list_procedures",
  "search_procedures",
  "list_strings",
  "search_strings",
  "procedure_address",
  "address_name",
  "procedure_pseudo_code",
  "procedure_assembly",
  "analyze_function",
  "procedure_callers",
  "procedure_callees",
  "xrefs",
] as const satisfies readonly Exclude<AnalysisOperation, "health">[]);
