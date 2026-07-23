import { z } from "zod";

import {
  procedureClassificationSchema,
  procedureIdentitySchema,
  localVariableSchema,
  functionDossierSchema,
} from "../domain/hopperValues.js";
import { analysisProfileSchema } from "../domain/analysisProfile.js";
import {
  PROVIDER_REJECTION_CODES,
  type ProviderRejectionCode,
} from "./providerSelection.js";
import { analysisErrorProjectionSchema } from "./errorSchemas.js";

/** Compact MCP result with an immutable link to complete session Evidence. */
export const evidenceResultOf = (schema: z.ZodType) =>
  z.strictObject({
    result: schema,
    evidence_id: z.string().regex(/^ev_[a-f0-9]{64}$/u),
    evidence_uri: z.string().regex(/^rea:\/\/evidence\/ev_[a-f0-9]{64}$/u),
  });

const resultOf = evidenceResultOf;
export const lifecycleResultOf = (schema: z.ZodType) =>
  z.object({ result: schema });

/** Resolve a required named output schema or reject contract drift. */
export const requireOutputSchema = (
  schemas: Readonly<Record<string, z.ZodObject>>,
  name: string,
): z.ZodObject => {
  const schema = schemas[name];
  if (schema === undefined)
    throw new Error(`Missing output schema for ${name}`);
  return schema;
};

export const targetFormatSchema = z.enum([
  "hopper",
  "analysis-database",
  "mach-o",
  "elf",
  "pe",
  "zip",
  "ipa",
  "apk",
  "msix",
  "appx",
  "asar",
  "dmg",
  "pkg",
  "plist",
  "javascript",
  "source-map",
]);

export const targetKindSchema = z.enum([
  "executable",
  "database",
  "archive",
  "artifact",
]);

const providerCapability = z.object({
  operation: z.string(),
  available: z.boolean(),
  reason: z.string().nullable(),
  availability_code: z.enum(PROVIDER_REJECTION_CODES).nullable(),
  input_contract_version: z.number().int().min(1),
  output_contract_version: z.number().int().min(1),
  pagination: z.enum(["none", "offset", "cursor"]),
  exhaustive: z.boolean(),
  effects: z.object({
    mutates_artifact: z.boolean(),
    launches_process: z.boolean(),
    may_show_ui: z.boolean(),
    may_access_network: z.boolean(),
    may_write_filesystem: z.boolean(),
    changes_permissions: z.boolean(),
    requires_root: z.boolean(),
  }),
  limits: z.object({
    max_results: z.number().int().min(0).nullable(),
    max_payload_bytes: z.number().int().min(0).nullable(),
    timeout_ms: z.number().int().min(0).nullable(),
  }),
  limitations: z.array(z.string()),
});

export const providerIdentity = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string().nullable(),
});

const processCoordinates = {
  launcher_pid: z.number().int().min(1),
  process_group_id: z.number().int().min(1),
};

const processLineageObservation = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("unavailable"),
    observed_at: z.iso.datetime(),
    ...processCoordinates,
    reason: z.string().min(1),
  }),
  z.object({
    status: z.literal("verified"),
    observed_at: z.iso.datetime(),
    schema_version: z.literal(1),
    ...processCoordinates,
    launcher_parent_pid: z.number().int().min(0),
    descendants: z.array(
      z.object({
        pid: z.number().int().min(1),
        parent_pid: z.number().int().min(0),
        process_group_id: z.number().int().min(1),
      }),
    ),
  }),
]);

const analysisRun = z
  .object({
    run_id: z.string().uuid(),
    process_lineage: z.discriminatedUnion("status", [
      z.object({ status: z.literal("not_observed") }),
      z.object({
        status: z.literal("snapshots"),
        snapshots: z.array(
          z.object({
            provider: providerIdentity,
            observation: processLineageObservation,
          }),
        ),
      }),
    ]),
  })
  .nullable();

export const analysisActivity = z.object({
  status: z.enum(["not_observed", "idle", "busy", "timed_out_busy"]),
  providers: z.array(
    z.object({
      provider: providerIdentity,
      active: z
        .object({
          request_id: z.number().int().min(1),
          operation: z.string().min(1),
          elapsed_ms: z.number().int().min(0),
          timeout_ms: z.number().int().min(0),
          caller_state: z.enum(["waiting", "timed_out", "cancelled"]),
        })
        .nullable(),
      queued_requests: z.number().int().min(0),
    }),
  ),
});

const providerRejectionCode: z.ZodType<ProviderRejectionCode> = z.enum(
  PROVIDER_REJECTION_CODES,
);

const providerDiagnostics = z.record(z.string(), z.json());

const providerAvailability = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"),
    code: z.null(),
    reason: z.null(),
    diagnostics: providerDiagnostics,
  }),
  z.object({
    status: z.literal("unavailable"),
    code: providerRejectionCode,
    reason: z.string().min(1),
    diagnostics: providerDiagnostics,
  }),
]);

const providerTargetSupport = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("unknown"),
    code: z.null(),
    reason: z.string().min(1),
    diagnostics: providerDiagnostics,
  }),
  z.object({
    status: z.literal("supported"),
    code: z.null(),
    reason: z.null(),
    diagnostics: providerDiagnostics,
  }),
  z.object({
    status: z.literal("unsupported"),
    code: z.enum([
      "target_kind_unsupported",
      "target_format_unsupported",
      "architecture_unsupported",
      "target_role_unsupported",
      "managed_target_unsupported",
    ]),
    reason: z.string().min(1),
    diagnostics: providerDiagnostics,
  }),
]);

export const toolAvailability = z.object({
  name: z.string(),
  surface: z.string(),
  available: z.boolean(),
  reason: z.enum([
    "available",
    "target_required",
    "provider_missing",
    "provider_unavailable",
    "target_unsupported",
    "unsupported_host",
    "policy_disabled",
  ]),
  remediation: z.string().nullable(),
  effects: z.strictObject({
    mutatesTarget: z.boolean(),
    mutatesSession: z.boolean(),
    writesFilesystem: z.boolean(),
    launchesProcess: z.boolean(),
    accessesNetwork: z.boolean(),
    changesUiState: z.boolean(),
    mayDiscardData: z.boolean(),
    idempotent: z.boolean(),
  }),
  annotations: z.object({
    read_only: z.boolean(),
    destructive: z.boolean(),
    idempotent: z.boolean(),
    open_world: z.boolean(),
  }),
});

export const sessionProvider = z.object({
  provider: providerIdentity,
  providers: z.array(providerIdentity),
  capabilities: z.array(providerCapability),
  analysis_run: analysisRun,
  analysis_activity: analysisActivity,
  analysis_provider_binding: z
    .object({
      provider: providerIdentity,
      selection_source: z.enum([
        "request",
        "environment",
        "auto-single-candidate",
      ]),
      analysis_profile: analysisProfileSchema,
    })
    .nullable(),
  analysis_provider_candidates: z.array(
    z.object({
      provider: providerIdentity,
      availability: providerAvailability,
      target_support: providerTargetSupport,
      selected: z.boolean(),
      capabilities: z.array(providerCapability),
    }),
  ),
  tool_availability: z.array(toolAvailability),
  client_features: z.object({
    elicitation_form: z.boolean(),
    elicitation_url: z.boolean(),
    roots: z.boolean(),
    sampling: z.boolean(),
  }),
  server_identity: z.object({
    package: z.object({
      name: z.string(),
      version: z.string(),
      root_path: z.string(),
      build_commit: z.string().nullable(),
    }),
    server: z.object({
      name: z.string(),
      version: z.string(),
      started_at: z.string(),
      command_path: z.string(),
    }),
    sdk: z.object({
      server: z.string(),
      client_test: z.string(),
      core: z.string(),
    }),
    negotiated_protocol_version: z.string().nullable(),
    client: z.object({ name: z.string(), version: z.string() }).nullable(),
    skill: z.object({ name: z.string(), expected_version: z.string() }),
    catalog: z.record(z.string(), z.json()),
    protocol_features: z.object({
      progress: z.boolean(),
      cancellation: z.boolean(),
      evidence_resources: z.boolean(),
      elicitation: z.boolean(),
    }),
    alignment: z.object({
      state: z.enum(["aligned", "mcp_server_restart_required", "unknown"]),
      reasons: z.array(z.string()),
      remediation: z.string().nullable(),
    }),
  }),
});

export const nullableText = z.string().nullable();
export const addressList = z.array(z.string());
export const addressedEntry = z.object({
  address: z.string(),
  name: z.string(),
});
export const procedureIdentity = procedureIdentitySchema;
const localVariable = localVariableSchema;

export const containingProcedureResolution = z.discriminatedUnion("found", [
  z.object({
    query_address: z.string(),
    found: z.literal(true),
    procedure: procedureIdentity,
  }),
  z.object({
    query_address: z.string(),
    found: z.literal(false),
    procedure: z.null(),
    reason: z.enum(["outside_segments", "not_in_procedure"]),
  }),
]);

const unavailable = z.object({
  available: z.literal(false),
  reason: z.string(),
});

const availableMemoryPermissions = z.object({
  available: z.literal(true),
  source: z.literal("ghidra-memory-block"),
});

export const bounded = (item: z.ZodType) =>
  z.object({
    items: z.array(item),
    total: z.number().int().min(0).nullable(),
    returned: z.number().int().min(0),
    truncated: z.boolean(),
    next_offset: z.number().int().min(0).nullable(),
  });

const addressedValue = z.object({
  address: z.string(),
  value: z.string(),
  value_truncated: z.boolean().optional(),
  symbol: z
    .object({
      primary: z.boolean(),
      dynamic: z.boolean(),
      external: z.boolean(),
      type: z.string(),
      source: z.enum(["default", "analysis", "ai", "imported", "user_defined"]),
    })
    .optional(),
  procedure: z
    .object({
      external: z.boolean(),
      thunk: z.boolean(),
      thunk_target: z.string().nullable(),
    })
    .optional(),
  string: z
    .object({
      encoding: z.string(),
      termination: z.enum(["missing", "present_or_not_required"]),
      byte_length: z.number().int().min(0),
    })
    .optional(),
});

export const pageOutput = z.object({
  items: z.array(addressedValue),
  offset: z.number().int().min(0),
  limit: z.number().int().min(1),
  total: z.number().int().min(0),
  next_offset: z.number().int().min(0).nullable(),
  has_more: z.boolean(),
});

export const searchPageOutput = pageOutput.extend({
  items: z.array(
    z.object({
      address: z.string(),
      value: z.string(),
      value_truncated: z.boolean(),
    }),
  ),
});

const memoryRegionOutput = z.object({
  name: z.string(),
  start: z.string(),
  end: z.string(),
  readable: z.boolean().nullable(),
  writable: z.boolean().nullable(),
  executable: z.boolean().nullable(),
  permissions: z.union([unavailable, availableMemoryPermissions]),
  provenance: z.enum(["hopper-public-python-api", "ghidra-memory-block"]),
  address_space: z.string().optional(),
  image_base: z.string().optional(),
  initialized: z.boolean().optional(),
  overlay: z.boolean().optional(),
});

export const segmentOutput = resultOf(
  z.array(memoryRegionOutput.extend({ sections: z.array(memoryRegionOutput) })),
);

export const procedureInfoOutput = resultOf(
  z.object({
    name: z.string(),
    entrypoint: z.string(),
    basicblock_count: z.number().int().min(0),
    length: z.number().min(0),
    signature: nullableText,
    locals: z.array(localVariable),
    classification: procedureClassificationSchema.nullable().default(null),
  }),
);

export const symbolDiscoveryOutput = (property: "classes" | "protocols") =>
  resultOf(
    z.object({
      count: z.number().int().min(0),
      [property]: z.array(addressedEntry),
    }),
  );

export const graphNode = z.discriminatedUnion("status", [
  z.object({
    address: z.string(),
    status: z.literal("ok"),
    calls: z.array(z.string()),
  }),
  z.object({
    address: z.string(),
    status: z.literal("error"),
    error: analysisErrorProjectionSchema,
  }),
]);

export const functionDossierOutput = resultOf(functionDossierSchema);
