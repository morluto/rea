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
      "Decode one local APK's resources with `apktool d --no-src` in a provider-owned workspace that is removed after projection: the readable AndroidManifest.xml, apktool.yml version and SDK facts, selected string resources, selectable locales, and decoded file count. Strings default to the first 2000 valid entries per table; string_offset/string_limit retrieve later pages, with table.page.next_offset and full source counts. Verify target.sha256 across calls. Per-call max_total_strings, max_string_table_bytes and max_total_string_table_bytes adjust output/read budgets without a REA restart. Smali is skipped because Java-source recovery belongs to JADX. decode_timeout_ms is the decode wall clock in milliseconds (default 600000, range 1..2147483647); it does not raise output capture or version-probe limits.",
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
