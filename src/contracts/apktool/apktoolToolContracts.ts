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
      "Decode APK resources with apktool d --no-src: readable manifest, version/SDK facts, string resources/locales and decoded file count. Uses a temporary workspace removed after projection; smali/source recovery belongs to JADX. Strings default to 2000 valid entries per table; use string_offset/string_limit and table.page.next_offset for later pages, checking target.sha256 across calls. Per-call string budgets can be raised without restart. decode_timeout_ms controls decoding (default 600000 ms), independently of output capture and version probes.",
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
      {
        title: "Decode multiple locale string tables in one pass",
        input: {
          path: "/targets/Example.apk",
          locales: ["de", "fr"],
          string_tables_only: true,
        },
      },
      {
        title: "Retrieve strings after the default first page",
        input: {
          path: "/targets/Example.apk",
          string_offset: 2000,
          string_limit: 100,
          string_tables_only: true,
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
