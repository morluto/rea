import {
  apktoolInputSchemas,
  apktoolResultSchemas,
} from "../../domain/apktool/apktoolResourceAnalysis.js";
import type { ToolContract } from "../toolContractTypes.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "../toolEffects.js";

/** Apktool resource decoding served by a caller-supplied launcher. */
export const APKTOOL_TOOL_CONTRACTS = [
  {
    name: "inspect_apktool_client",
    ...toolContractMetadata("inspect_apktool_client"),
    description:
      "Inspect the caller-selected apktool launcher: resolved command, selection source, and version. Decodes nothing. REA never installs Apktool or Java; select a launcher with REA_APKTOOL_COMMAND (absolute) or apktool on PATH.",
    kind: "apktool-provider",
    inputSchema: apktoolInputSchemas.inspect_apktool_client,
    outputSchema: evidenceResultOf(apktoolResultSchemas.inspect_apktool_client),
    examples: [{ title: "Check the Apktool launcher", input: {} }],
  },
  {
    name: "decode_android_resources",
    ...toolContractMetadata("decode_android_resources"),
    description:
      "Decode one local APK's resources with `apktool d --no-src` in a provider-owned workspace that is removed after projection: the readable AndroidManifest.xml, apktool.yml version and SDK facts, the app's string resources (default or one locale, bounded to 2000 entries), available string locales, and the decoded file count. The target APK is digest with SHA-256 before decoding; smali is skipped because Java-source recovery belongs to the JADX family.",
    kind: "apktool-provider",
    inputSchema: apktoolInputSchemas.decode_android_resources,
    outputSchema: evidenceResultOf(
      apktoolResultSchemas.decode_android_resources,
    ),
    examples: [
      {
        title: "Decode an APK's resources",
        input: { path: "/targets/Example.apk" },
      },
      {
        title: "Decode one locale's strings",
        input: { path: "/targets/Example.apk", locale: "de" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
