import { z } from "incur";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { cliDecimalField, publishArgvInput } from "./options.js";
import { localPathStringSchema } from "../domain/localPath.js";
import {
  inspectStructuredRasterCandidatesInputSchema,
  structuredRasterGrammarSchema,
  rasterLogicalSegmentSchema,
} from "../domain/native/structuredRasterCandidates.js";
import { createStructuredRasterDiscoveryService } from "../composition/binaryDiagnostics.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { logCliCommand } from "../cliLogging.js";
import { finishCliEvidenceCommand } from "./cliEvidenceCallerPath.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
const jsonValue = z.string().transform((value, ctx): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    ctx.addIssue({ code: "custom", message: "Expected valid JSON" });
    return z.NEVER;
  }
});
/** Explicit configured family search; no target execution or automatic firmware identification. */
export function registerStructuredRasterCommands(
  cli: CliInstance,
  logger: Logger,
): void {
  const fields = inspectStructuredRasterCandidatesInputSchema.shape;
  cli.command(CLI_COMMANDS.inspectStructuredRasterCandidates, {
    description:
      "Find descriptor-table raster hypotheses under an explicit grammar and logical mapping",
    args: z.object({ path: localPathStringSchema }),
    options: z.object({
      offset: cliDecimalField(fields.offset),
      length: cliDecimalField(fields.length),
      profile: fields.profile,
      segments: publishArgvInput(
        jsonValue
          .pipe(z.array(rasterLogicalSegmentSchema).min(1).max(4096))
          .optional(),
      ),
      grammar: publishArgvInput(
        jsonValue.pipe(structuredRasterGrammarSchema).optional(),
      ),
      minRecords: cliDecimalField(fields.min_records),
      minConsistency: z
        .string()
        .regex(/^(?:0\.[5-9][0-9]*|1(?:\.0+)?)$/u)
        .optional(),
      maxWork: cliDecimalField(fields.max_work),
      maxTables: cliDecimalField(fields.max_tables),
      maxRecords: cliDecimalField(fields.max_records),
      bitsPerPixel: z
        .array(cliDecimalField(z.number().int()))
        .max(7)
        .optional(),
      offsetUnits: z.array(cliDecimalField(z.number().int())).max(3).optional(),
      resourceOffset: cliDecimalField(fields.resource_offset),
      maxResources: cliDecimalField(fields.max_resources),
      maxPreviews: cliDecimalField(fields.max_previews),
      thumbnailSide: cliDecimalField(fields.thumbnail_side),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(
          logger,
          CLI_COMMANDS.inspectStructuredRasterCandidates,
          async () => {
            const service = createStructuredRasterDiscoveryService();
            return finishCliEvidenceCommand(
              args.path,
              () =>
                service.inspect(
                  {
                    path: absoluteCallerPath(args.path),
                    offset: options.offset,
                    length: options.length,
                    profile: options.profile,
                    segments: options.segments,
                    grammar: options.grammar,
                    min_records: options.minRecords,
                    ...(options.minConsistency === undefined
                      ? {}
                      : { min_consistency: Number(options.minConsistency) }),
                    max_work: options.maxWork,
                    max_tables: options.maxTables,
                    max_records: options.maxRecords,
                    bits_per_pixel: options.bitsPerPixel,
                    offset_units: options.offsetUnits,
                    resource_offset: options.resourceOffset,
                    max_resources: options.maxResources,
                    max_previews: options.maxPreviews,
                    thumbnail_side: options.thumbnailSide,
                  },
                  { signal },
                ),
              service,
              "rea-workflow",
              "inspect_structured_raster_candidates",
              signal,
            ).then(projectCliAnalysisResult);
          },
        ),
      ),
  });
}
