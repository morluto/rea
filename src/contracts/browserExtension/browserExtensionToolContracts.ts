import type { ToolContract } from "../toolContractTypes.js";
import { evidenceEffects, toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import {
  browserExtensionSchema,
  inspectBrowserExtensionInputSchema,
} from "../../domain/browserExtension/browserExtension.js";

/** Static browser-extension surface inspection. No browser and no store. */
export const BROWSER_EXTENSION_TOOL_CONTRACTS = [
  {
    name: "inspect_browser_extension",
    availability: "standalone",
    cli: true,
    ...toolContractMetadata("inspect_browser_extension", evidenceEffects),
    kind: "artifact-provider",
    description:
      "Inspect one explicit local CRX2, CRX3, XPI, ZIP, or unpacked manifest.json. Returns the declared manifest surface: manifest version, permissions, host permissions, content-script matches, background entry, Gecko id, action keys, and unknown top-level keys, with artifact SHA-256 Evidence. CRX header lengths are measured; signatures are not verified. Extension code, locale catalogs, and runtime grants remain unexamined. Reads a stable regular file. A directory is not an input. Malformed containers and exhausted budgets return no partial success. Portable on supported Node hosts; no browser or store is required.",
    inputSchema: inspectBrowserExtensionInputSchema,
    outputSchema: evidenceResultOf(browserExtensionSchema),
    examples: [
      {
        title: "Inspect a Chromium CRX or Firefox XPI manifest surface",
        input: { path: "/artifacts/extension.crx" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
