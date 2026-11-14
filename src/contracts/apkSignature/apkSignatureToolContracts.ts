import { z } from "zod";
import { apkSignatureResultSchema } from "../../domain/apkSignature/apkSignatureReport.js";
import { inspectApkSignatureInputSchema } from "../../domain/apkSignature/apkSignatureQuery.js";
import {
  apkSignaturePageViewResultSchema,
  apkSignatureSummaryViewResultSchema,
} from "../../domain/analysisView/analysisViewResult.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** Static APK signature-scheme inspection of a selected local archive. */
export const INSPECT_APK_SIGNATURE_CONTRACT = {
  name: "inspect_apk_signature",
  ...toolContractMetadata("inspect_apk_signature"),
  kind: "artifact-provider",
  requiresActiveTarget: true,
  description:
    "Inspect declared APK v1/v2/v3/v3.1 signers, certificate fingerprints, digests, SDK ranges, rotation lineage and source stamp without executing Android code. Returns exact file SHA-256; identities include scheme/source ordinal and certificates retain DER digests. Default summary retains complete Evidence; optional view selects signers/digests/lineage by IDs/schemes/fields and pages. Reuse inspect_analysis_view kind apk-signature after removing the source. Matching content digests do not verify signatures or authenticity; lineage trust and v1 entry coverage remain unverified. No device, network or SDK; malformed structures and resource refusals are explicit.",
  inputSchema: inspectApkSignatureInputSchema,
  outputSchema: evidenceResultOf(
    z.union([
      apkSignatureResultSchema,
      apkSignatureSummaryViewResultSchema,
      apkSignaturePageViewResultSchema,
    ]),
  ),
  examples: [
    {
      title: "Identify who signed an APK and under which schemes",
      input: { path: "/artifacts/app.apk" },
    },
  ],
} as const satisfies ToolContract;

/** Keep the public catalog in its existing order, using its named contract. */
export const APK_SIGNATURE_TOOL_CONTRACTS = [
  INSPECT_APK_SIGNATURE_CONTRACT,
] as const;
