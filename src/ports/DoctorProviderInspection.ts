import type { JsonValue } from "../domain/jsonValue.js";

/** One actionable environment diagnostic. */
export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly classification:
    | "healthy"
    | "missing_dependency"
    | "runtime_failure"
    | "unsupported_host"
    | "unsupported_target"
    | "missing_analysis_engine"
    | "unknown"
    | "config_drift";
  readonly detail?: string;
  readonly details?: Readonly<Record<string, JsonValue>>;
  readonly remediation?: string;
}

/** One provider-owned check projected without importing its adapter types. */
export interface DoctorProviderCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly code: string | null;
  readonly detail: string;
  readonly remediation: string | null;
  readonly classification: Exclude<DoctorCheck["classification"], "healthy">;
  readonly details?: Readonly<Record<string, JsonValue>>;
}

/** Read-only provider inspection supplied by an outer composition adapter. */
export interface DoctorProviderInspection {
  readonly id: string;
  /** Null means the selected client's setting could not be determined. */
  readonly configured: boolean | null;
  /** Null means readiness cannot be established for the selected client. */
  readonly available: boolean | null;
  readonly providerVersion: string | null;
  /** Validated discoveries used as registration defaults. Setup preserves
   * caller-selected configuration separately from these readiness facts. */
  readonly registrationEnvironment: Readonly<Record<string, string>>;
  readonly checks: readonly DoctorProviderCheck[];
}
