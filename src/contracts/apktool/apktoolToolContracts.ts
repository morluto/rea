import { z } from "zod";
import {
  apktoolInputSchemas,
  apktoolResultSchemas,
} from "../../domain/apktool/apktoolResourceAnalysis.js";
import { apktoolResourcesViewRequestSchema } from "../../domain/apktool/apktoolResourcesQuery.js";
import {
  apktoolResourcesPageViewResultSchema,
  apktoolResourcesSummaryViewResultSchema,
} from "../../domain/analysisView/summarySchemas/apktoolResourcesSummarySchemas.js";
import { analysisDetailSchema } from "../analysisDetail.js";
import type { ToolContract } from "../toolContractTypes.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import { toolContractMetadata, toolEffects } from "../toolEffects.js";

/** Decode request with its delivery selection, which never reaches Apktool. */
export const decodeAndroidResourcesRequestSchema =
  apktoolInputSchemas.decode_android_resources
    .extend({
      detail: analysisDetailSchema,
      view: apktoolResourcesViewRequestSchema
        .optional()
        .describe(
          "A strings or manifest page of the retained decode, returned instead of the summary; requires detail summary",
        ),
    })
    .superRefine((value, context) => {
      if (value.view !== undefined && value.detail !== "summary")
        context.addIssue({
          code: "custom",
          path: ["view"],
          message:
            "A resources view requires detail summary; complete detail returns the complete decode.",
        });
    });

/** Apktool resource decoding served by a caller-supplied launcher. */
export const APKTOOL_TOOL_CONTRACTS = [
  {
    name: "inspect_apktool_client",
    cli: true,
    ...toolContractMetadata(
      "inspect_apktool_client",
      toolEffects({
        mutatesSession: true,
        launchesProcess: true,
      }),
    ),
    description:
      "Inspect the caller-selected apktool launcher: resolved command, selection source, and version. Decodes nothing. REA never installs Apktool or Java; select a launcher with REA_APKTOOL_COMMAND (absolute) or apktool on PATH.",
    kind: "apktool-provider",
    inputSchema: apktoolInputSchemas.inspect_apktool_client,
    outputSchema: evidenceResultOf(apktoolResultSchemas.inspect_apktool_client),
    examples: [{ title: "Check the Apktool launcher", input: {} }],
  },
  {
    name: "decode_android_resources",
    cli: true,
    ...toolContractMetadata(
      "decode_android_resources",
      toolEffects({
        mutatesSession: true,
        launchesProcess: true,
        writesFilesystem: true,
      }),
    ),
    description:
      'Decode APK resources with apktool d --no-src: readable manifest, version/SDK facts, string resources/locales and decoded file count. Uses a temporary workspace removed after projection; smali/source recovery belongs to JADX. Strings default to 2000 valid entries per table; use string_offset/string_limit and table.page.next_offset for later pages, checking target.sha256 across calls. Per-call string budgets can be raised without restart. decode_timeout_ms controls decoding (default 600000 ms), independently of output capture and version probes. locales lists every locale that has a strings.xml table. Omitted detail returns the decode inline when it fits the agent result budget, else retains it and returns counts without strings or manifest text. With detail summary, view {kind: "android-resources", facet: "strings"} pages strings across decoded tables, filtered by locales (null is the default table), names or name_prefixes; facet manifest pages the manifest text. Later pages use inspect_analysis_view with parent_evidence_id.',
    kind: "apktool-provider",
    inputSchema: decodeAndroidResourcesRequestSchema,
    outputSchema: evidenceResultOf(
      z.union([
        apktoolResultSchemas.decode_android_resources,
        apktoolResourcesSummaryViewResultSchema,
        apktoolResourcesPageViewResultSchema,
      ]),
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
        title: "Read two locales' values of one string",
        input: {
          path: "/targets/Example.apk",
          locales: ["de", "ja"],
          string_tables_only: true,
          detail: "summary",
          view: {
            kind: "android-resources",
            facet: "strings",
            locales: ["de", "ja"],
            names: ["app_name"],
          },
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
