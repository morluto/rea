import type { JsonValue } from "../domain/jsonValue.js";
import type { WindowsNativeReadiness } from "../process/WindowsAuthority.js";

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

/** Why a failed check failed. A passing check is always `healthy`. */
export type DoctorFailureClassification = Exclude<
  DoctorCheck["classification"],
  "healthy"
>;

/** What a provider reports when one of its checks fails. */
export interface DoctorProviderCheckFailure {
  readonly code: string | null;
  readonly remediation: string | null;
  readonly classification: DoctorFailureClassification;
}

/**
 * One provider-owned check projected without importing its adapter types. A
 * failure classification, code, and remediation belong to failed checks only.
 */
export type DoctorProviderCheck = {
  readonly name: string;
  readonly detail: string;
  readonly details?: Readonly<Record<string, JsonValue>>;
} & (
  | {
      readonly ok: true;
      readonly code: null;
      /** Advisory guidance a passing check may still carry. */
      readonly remediation: string | null;
      readonly classification: "healthy";
    }
  | ({ readonly ok: false } & DoctorProviderCheckFailure)
);

/** An observed provider setting and the input layer supplying it. */
export interface DoctorProviderSetting {
  readonly value: string;
  readonly source: "env" | "config" | "auto";
}

/** Doctor classification of a Windows native control this host did not prove. */
export const windowsNativeFailureClassification = (
  code: Extract<WindowsNativeReadiness, { available: false }>["code"],
): DoctorFailureClassification =>
  code === "runtime_missing"
    ? "missing_dependency"
    : code === "runtime_unavailable"
      ? "runtime_failure"
      : "unsupported_host";

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
  /** Effective literal or discovered values with the source that supplied them. */
  readonly providerSettings?: Readonly<Record<string, DoctorProviderSetting>>;
  readonly checks: readonly DoctorProviderCheck[];
}
