import {
  canonicalizeArtifactInputSchema,
  canonicalizeArtifactSchema,
} from "../../domain/canonicalize/canonicalizeArtifact.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** Antidote pass: a generalized, shield-agnostic anti-exhaustion canonicalizer. */
export const CANONICALIZE_ARTIFACT_CONTRACT = {
  name: "canonicalize_artifact",
  ...toolContractMetadata("canonicalize_artifact"),
  kind: "native-provider",
  description:
    "Antidote: deterministically canonicalize one selected local artifact into bounded, structured facts that neutralize decoy, padding and anti-instrumentation shields (BLA is one reference target) without executing, importing or mutating it. Separates cheap extraction from reasoning so adversarial bytes never reach a token budget. Recognizes WASM, Electron .asar and structured JSON (auto or explicit format). Drops non-semantic padding (WASM custom sections, inflated .asar inventory, oversized/deeply nested JSON) to exemplar-plus-count-plus-digest, keeps behavior-relevant core and link-relevant sections, flags unreferenced entries, and reports truncated/unverified as first-class state. Lossless for behavior-relevant data: it only changes what the analyzer ingests, never the target. Bounds its own memory and work so an inflated input cannot exhaust the pass itself.",
  inputSchema: canonicalizeArtifactInputSchema,
  outputSchema: evidenceResultOf(canonicalizeArtifactSchema),
  examples: [
    {
      title: "Canonicalize a possibly hardened Electron archive",
      input: { path: "/artifacts/app.asar" },
    },
    {
      title:
        "Canonicalize a WASM module, dropping non-semantic custom sections",
      input: { path: "/artifacts/core.wasm", format: "wasm" },
    },
  ],
} as const satisfies ToolContract;

/** Keep the public catalog in its existing order, using its named contract. */
export const CANONICALIZE_TOOL_CONTRACTS = [
  CANONICALIZE_ARTIFACT_CONTRACT,
] as const;
