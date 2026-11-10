import { z } from "zod";
import {
  desktopApplicationSchema,
  inspectDesktopApplicationInputSchema,
} from "../domain/desktopApplication.js";
import { desktopApplicationSummaryViewResultSchema } from "../domain/analysisView/analysisView.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "./toolEffects.js";
import type { ToolContract } from "./toolContractTypes.js";

/** Static directory triage belongs to the existing artifact family. */
export const DESKTOP_APPLICATION_TOOL_CONTRACTS = [
  {
    name: "inspect_desktop_application",
    ...toolContractMetadata("inspect_desktop_application"),
    kind: "artifact-provider",
    requiresActiveTarget: true,
    description:
      "Identify runtime candidates and next probes in a local desktop app directory from bounded listings, headers and metadata. Recognizes .NET, Unity Mono/IL2CPP, Unreal, Godot, GameMaker and Electron; returns supporting paths and range hashes. Default summary retains complete Evidence for inspect_analysis_view kind desktop-application; detail complete returns retained facts inline. Identity covers examined ranges, not every file byte. Coverage and unavailable probes remain explicit. No target execution, extraction, network or target changes.",
    inputSchema: inspectDesktopApplicationInputSchema.extend({
      detail: z.enum(["summary", "complete"]).default("summary"),
    }),
    outputSchema: evidenceResultOf(
      z.union([
        desktopApplicationSchema,
        desktopApplicationSummaryViewResultSchema,
      ]),
    ),
    examples: [
      {
        title: "Identify a desktop installation",
        input: { path: "/artifacts/application" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
