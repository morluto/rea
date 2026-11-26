import { z } from "zod";
import { evidenceInputSchema } from "../../domain/evidenceReference.js";
import { androidDeclarationComparisonSchema } from "../../domain/android/androidDeclarationComparison.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import { toolContractMetadata, evidenceEffects } from "../toolEffects.js";
import type { ToolContract } from "../toolContractTypes.js";

export const compareAndroidDeclarationsInputSchema = z.strictObject({
  left: evidenceInputSchema.describe(
    "Complete inspect_android_package Evidence or exact retained reference",
  ),
  right: evidenceInputSchema.describe(
    "Complete inspect_android_package Evidence or exact retained reference",
  ),
});

export const COMPARE_ANDROID_DECLARATIONS_CONTRACT = {
  name: "compare_android_declarations",
  cli: true,
  ...toolContractMetadata("compare_android_declarations", evidenceEffects),
  kind: "application",
  description:
    "Compare SDK, permission-list observations and static component declarations from two complete inspect_android_package Evidence records, without reopening APKs or running JADX. Use {left,right} with inline Evidence or {kind:'retained-evidence',evidence_id}; CLI references require --evidence-bundle. Summary/view Evidence must select its parent_evidence_id instead. Reports unique kind/resolved-name component additions/removals and exported/default, permission/source and authority-set changes with exact source indices/locations. Duplicate or incomplete inventories and null attributes stay unknown. Permission-list differences are observed only because the producer does not declare their coverage. Retains APK/package/version/engine identity; no runtime access, security, rename or compatibility inference.",
  inputSchema: compareAndroidDeclarationsInputSchema,
  outputSchema: evidenceResultOf(androidDeclarationComparisonSchema),
  examples: [],
} as const satisfies ToolContract;
