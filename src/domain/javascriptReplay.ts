import { z } from "zod";

import { evidenceEnvelopeSchema } from "./evidence.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const absolutePathSchema = z.string().startsWith("/").max(4096);
const aliasSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_./:@-]+$/u);

const replayModuleSchema = z
  .object({
    alias: aliasSchema,
    path: absolutePathSchema,
    format: z.enum(["esm", "commonjs-factory"]),
    role: z.enum(["module", "stub"]).default("module"),
    dependencies: z
      .record(z.string().min(1).max(256), aliasSchema)
      .refine((value) => Object.keys(value).length <= 128, {
        message: "Replay modules may declare at most 128 dependencies",
      })
      .default({}),
  })
  .strict();

const replaySideSchema = z
  .object({
    modules: z.array(replayModuleSchema).min(1).max(128),
    entry_alias: aliasSchema,
    entry_export: z.string().min(1).max(256).default("default"),
  })
  .strict();

const explicitCaseSchema = z
  .object({
    case_id: z.string().min(1).max(128),
    arguments: z.array(z.json()).max(16),
  })
  .strict();

const generatorSchema = z
  .object({
    preset: z.enum([
      "parser-boundaries",
      "sanitizer-boundaries",
      "clipboard-boundaries",
    ]),
    seed: z.number().int().min(0).max(0xffff_ffff),
    count: z.number().int().min(1).max(64),
  })
  .strict();

const replayLimitsSchema = z
  .object({
    wall_time_ms: z.number().int().min(100).max(10_000).default(3_000),
    memory_bytes: z
      .number()
      .int()
      .min(16 * 1024 * 1024)
      .max(512 * 1024 * 1024)
      .default(128 * 1024 * 1024),
    tasks: z.number().int().min(1).max(32).default(8),
    cpu_quota_percent: z.number().int().min(1).max(100).default(50),
    tmpfs_bytes: z
      .number()
      .int()
      .min(1024 * 1024)
      .max(64 * 1024 * 1024)
      .default(16 * 1024 * 1024),
    module_bytes: z
      .number()
      .int()
      .min(1)
      .max(16 * 1024 * 1024)
      .default(4 * 1024 * 1024),
    input_bytes: z
      .number()
      .int()
      .min(1)
      .max(1024 * 1024)
      .default(256 * 1024),
    protocol_bytes: z
      .number()
      .int()
      .min(1024 * 1024)
      .max(64 * 1024 * 1024)
      .default(16 * 1024 * 1024),
    output_bytes: z
      .number()
      .int()
      .min(1)
      .max(4 * 1024 * 1024)
      .default(512 * 1024),
    stderr_bytes: z
      .number()
      .int()
      .min(0)
      .max(256 * 1024)
      .default(32 * 1024),
    result_depth: z.number().int().min(1).max(64).default(16),
    result_nodes: z.number().int().min(1).max(100_000).default(10_000),
  })
  .strict();

const determinismSchema = z
  .object({
    clock_iso: z.iso.datetime().default("2000-01-01T00:00:00.000Z"),
    random_seed: z.number().int().min(0).max(0xffff_ffff).default(0),
    locale: z.literal("en-US").default("en-US"),
    timezone: z.literal("UTC").default("UTC"),
    platform: z.literal("linux").default("linux"),
  })
  .strict();

export const controlledReplayInputSchema = z
  .object({
    mode: z.enum(["plan", "execute"]),
    left: replaySideSchema,
    right: replaySideSchema.optional(),
    cases: z.array(explicitCaseSchema).max(128).default([]),
    generator: generatorSchema.optional(),
    determinism: determinismSchema.default({
      clock_iso: "2000-01-01T00:00:00.000Z",
      random_seed: 0,
      locale: "en-US",
      timezone: "UTC",
      platform: "linux",
    }),
    limits: replayLimitsSchema.default({
      wall_time_ms: 3_000,
      memory_bytes: 128 * 1024 * 1024,
      tasks: 8,
      cpu_quota_percent: 50,
      tmpfs_bytes: 16 * 1024 * 1024,
      module_bytes: 4 * 1024 * 1024,
      input_bytes: 256 * 1024,
      protocol_bytes: 16 * 1024 * 1024,
      output_bytes: 512 * 1024,
      stderr_bytes: 32 * 1024,
      result_depth: 16,
      result_nodes: 10_000,
    }),
    approved: z.boolean().default(false),
    plan_digest: digestSchema.optional(),
    reproducer_export: z
      .object({
        path: absolutePathSchema,
        approved: z.boolean(),
        include_sources: z.boolean().default(false),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.cases.length === 0 && value.generator === undefined)
      context.addIssue({
        code: "custom",
        path: ["cases"],
        message: "At least one explicit or generated case is required",
      });
    if (value.cases.length + (value.generator?.count ?? 0) > 128)
      context.addIssue({
        code: "custom",
        path: ["generator", "count"],
        message: "Explicit and generated replay cases must total at most 128",
      });
    if (
      value.mode === "execute" &&
      (value.approved !== true || value.plan_digest === undefined)
    )
      context.addIssue({
        code: "custom",
        path: ["approved"],
        message: "Execution requires literal approval and a plan digest",
      });
  });

const moduleCommitmentSchema = z
  .object({
    alias: aliasSchema,
    canonical_path: z.string().min(1),
    format: z.enum(["esm", "commonjs-factory"]),
    role: z.enum(["module", "stub"]),
    byte_count: z.number().int().min(0),
    sha256: digestSchema,
    dependencies: z.record(z.string(), aliasSchema),
  })
  .strict();

const runtimeIdentitySchema = z
  .object({
    path: z.string().min(1),
    version: z.string().min(1),
    sha256: digestSchema,
  })
  .strict();

const runtimeFileIdentitySchema = z
  .object({
    source_path: z.string().min(1),
    destination_path: z.string().min(1),
    sha256: digestSchema,
  })
  .strict();

const replayPlanSchema = z
  .object({
    schema_version: z.literal(1),
    plan_digest: digestSchema,
    policy_version: z.literal("linux-bwrap-systemd-v1"),
    policy_sha256: digestSchema,
    network: z.literal("none"),
    filesystem: z
      .object({
        host_writes: z.literal(false),
        private_tmpfs_bytes: z.number().int(),
      })
      .strict(),
    runtime: z
      .object({
        executable: runtimeIdentitySchema,
        worker: runtimeIdentitySchema,
        read_only_files: z.array(runtimeFileIdentitySchema).min(1),
      })
      .strict(),
    sandbox: z
      .object({
        bubblewrap: runtimeIdentitySchema,
        systemd_run: runtimeIdentitySchema,
        systemctl: runtimeIdentitySchema,
        shell: runtimeIdentitySchema,
        seccomp_sha256: digestSchema,
      })
      .strict(),
    left: z
      .object({
        modules: z.array(moduleCommitmentSchema),
        entry_alias: aliasSchema,
        entry_export: z.string(),
      })
      .strict(),
    right: z
      .object({
        modules: z.array(moduleCommitmentSchema),
        entry_alias: aliasSchema,
        entry_export: z.string(),
      })
      .strict()
      .optional(),
    cases: z.array(
      z
        .object({
          case_id: z.string(),
          arguments: z.array(z.json()),
          sha256: digestSchema,
        })
        .strict(),
    ),
    determinism: determinismSchema,
    limits: replayLimitsSchema,
    effects: z.array(z.string()),
    reproducer_export: z
      .object({
        path: z.string().min(1),
        include_sources: z.boolean(),
        authority: z.literal("evidence_write"),
      })
      .strict()
      .nullable(),
  })
  .strict();

const replayOutcomeSchema = z
  .object({
    case_id: z.string(),
    outcome: z.enum([
      "return",
      "exception",
      "serialization_error",
      "denied",
      "timeout",
      "oom",
      "crash",
      "cancelled",
      "protocol_error",
    ]),
    value: z.json().optional(),
    exception: z
      .object({
        name: z.string(),
        message: z.string(),
        stack: z.string().nullable(),
      })
      .strict()
      .optional(),
    input_sha256: digestSchema,
    output_sha256: digestSchema.nullable(),
    truncated: z.boolean(),
  })
  .strict();

export const replayExecutionResultSchema = z
  .object({
    schema_version: z.literal(1),
    plan_digest: digestSchema,
    outcomes: z.array(replayOutcomeSchema),
    comparison: z
      .array(
        z
          .object({
            case_id: z.string(),
            status: z.enum(["equal", "changed", "unknown"]),
            left_index: z.number().int(),
            right_index: z.number().int(),
          })
          .strict(),
      )
      .optional(),
    stderr: z.string(),
    termination: z.enum([
      "completed",
      "timeout",
      "oom",
      "crash",
      "cancelled",
      "protocol_error",
    ]),
    cleanup: z
      .object({
        state: z.enum(["complete", "incomplete"]),
        residual_resources: z.array(z.string()),
      })
      .strict(),
    limitations: z.array(z.string()),
    reproducer: z
      .discriminatedUnion("state", [
        z
          .object({
            state: z.literal("written"),
            path: z.string(),
            sha256: digestSchema,
          })
          .strict(),
        z
          .object({
            state: z.literal("failed"),
            path: z.string(),
            error: z.string(),
          })
          .strict(),
      ])
      .nullable(),
  })
  .strict();

export const replayEvidenceSchema = evidenceEnvelopeSchema
  .omit({ normalized_result: true })
  .extend({ normalized_result: replayExecutionResultSchema });

export const controlledReplayOutputSchema = z
  .object({
    phase: z.enum(["plan", "execute"]),
    plan: replayPlanSchema.nullable(),
    source_evidence: z.array(replayEvidenceSchema),
    evidence: replayEvidenceSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.phase === "plan" &&
        (value.plan === null ||
          value.evidence !== null ||
          value.source_evidence.length !== 0)) ||
      (value.phase === "execute" &&
        (value.plan !== null ||
          value.evidence === null ||
          value.source_evidence.length === 0))
    )
      context.addIssue({
        code: "custom",
        message: "Replay output phase does not match its payload",
      });
  });

export type ControlledReplayInput = z.infer<typeof controlledReplayInputSchema>;
export type ReplayPlan = z.infer<typeof replayPlanSchema>;
export type ReplayExecutionResult = z.infer<typeof replayExecutionResultSchema>;
