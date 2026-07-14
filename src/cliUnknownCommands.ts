import { Cli, z } from "incur";

import type { UnknownRegistry } from "./application/UnknownRegistry.js";
import type { Logger } from "./logger.js";
import type {
  RecordUnknownInput,
  UpdateUnknownInput,
} from "./domain/residualUnknown.js";

/** Register residual-unknown registry CLI commands. */
export const registerUnknownCommands = (
  cli: ReturnType<typeof Cli.create>,
  _logger: Logger,
  registry: UnknownRegistry,
): void => {
  cli.command("unknowns", {
    description: "List recorded residual unknowns with optional filters",
    options: z.object({
      status: z
        .enum(["open", "investigating", "blocked", "contradicted", "resolved"])
        .optional()
        .describe("Filter by status"),
      severity: z
        .enum(["low", "medium", "high", "critical"])
        .optional()
        .describe("Filter by severity"),
      domain: z.string().optional().describe("Filter by domain"),
    }),
    run: ({ options }): ReturnType<typeof registry.listUnknowns> => {
      const filters: {
        status?:
          | "open"
          | "investigating"
          | "blocked"
          | "contradicted"
          | "resolved";
        severity?: "low" | "medium" | "high" | "critical";
        domain?: string;
      } = {};
      if (options.status !== undefined) filters.status = options.status;
      if (options.severity !== undefined) filters.severity = options.severity;
      if (options.domain !== undefined) filters.domain = options.domain;
      return registry.listUnknowns(filters);
    },
  });

  cli.command("unknown-record", {
    description: "Record one approved residual unknown question",
    options: z.object({
      question: z.string().min(1).max(1_000).describe("The bounded question"),
      severity: z
        .enum(["low", "medium", "high", "critical"])
        .describe("Severity of the unknown"),
      domain: z.string().min(1).max(100).describe("Domain of the unknown"),
      authority: z
        .enum([
          "shipped-artifact",
          "controlled-replay",
          "historical-reference",
          "external-service",
          "analyst-inference",
        ])
        .describe("Required authority to resolve"),
      confidence: z
        .enum(["observed", "derived", "inferred"])
        .describe("Required confidence level"),
      evidence: z
        .string()
        .min(1)
        .describe("Mutation evidence ID for this record operation"),
    }),
    run: ({ options }) =>
      registry.recordUnknown(
        {
          question: options.question,
          severity: options.severity,
          domain: options.domain,
          required_authority: options.authority,
          required_confidence: options.confidence,
          required_environment: null,
          supporting_evidence_ids: [],
          contradicting_evidence_ids: [],
          recommended_probes: [],
          relationships: [],
          approved: true,
        } as RecordUnknownInput,
        options.evidence,
      ),
  });

  cli.command("unknown-update", {
    description: "Update one residual unknown with new evidence or status",
    options: z.object({
      id: z.string().describe("Unknown ID (unk_…)"),
      revision: z.number().int().min(1).describe("Expected current revision"),
      status: z
        .enum(["open", "investigating", "blocked", "contradicted", "resolved"])
        .describe("New status"),
      severity: z
        .enum(["low", "medium", "high", "critical"])
        .describe("New severity"),
      evidence: z
        .string()
        .min(1)
        .describe("Mutation evidence ID for this update operation"),
    }),
    run: ({ options }) =>
      registry.updateUnknown(
        {
          unknown_id: options.id,
          expected_revision: options.revision,
          approved: true,
          status: options.status,
          severity: options.severity,
          required_authority: null,
          required_confidence: "observed",
          required_environment: null,
          supporting_evidence_ids: [],
          contradicting_evidence_ids: [],
          recommended_probes: [],
          relationships: [],
          resolution: null,
        } as unknown as UpdateUnknownInput,
        options.evidence,
      ),
  });

  cli.command("unknown-verify", {
    description: "Verify the resolution state of one residual unknown",
    options: z.object({
      id: z.string().describe("Unknown ID (unk_…)"),
    }),
    run: ({ options }) => registry.verifyUnknownResolution(options.id),
  });
};
