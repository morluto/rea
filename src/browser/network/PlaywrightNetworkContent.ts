import { decodeStrictUtf8 } from "../../domain/strictUtf8.js";
import { isTransportCredentialHeader } from "../../domain/explicitSensitiveValues.js";
import {
  isJson,
  mediaTypeEssence,
} from "../../domain/analysisView/recordedMediaType.js";
import { safeParseJson } from "../../domain/safeJson.js";
import {
  browserContentType,
  CONTENT_TYPE_HEADER,
} from "../../domain/browserNetworkMediaType.js";

import {
  AnalysisCancelledError,
  AnalysisTimeoutError,
} from "../../domain/analysisErrorCore.js";
import type {
  BrowserNetworkBody,
  BrowserNetworkHeaders,
} from "../../domain/browserNetworkEvidence.js";
import type {
  BrowserScenarioEventAdmission,
  BrowserScenarioEventBudgetReason,
} from "../../domain/browserScenarioCaptureValues.js";
import type {
  BrowserScenarioSecrets,
  ScenarioRedactionScope,
} from "../BrowserScenarioSecrets.js";
import { withPlaywrightExecutionBoundary } from "../PlaywrightExecutionBoundary.js";
import { sha256Hex } from "../../kernel/sha256Hex.js";

/** The producer seam for ordered, duplicate-preserving HTTP headers. */
export interface NetworkHeadersSource {
  headers(): Record<string, string>;
  headersArray(): Promise<{ name: string; value: string }[]>;
}

/** A bounded read cannot delay browser cleanup indefinitely. */
export interface NetworkReadOptions {
  readonly redactionScope?: ScenarioRedactionScope;
  readonly timeoutMs: number;
  readonly maxBodyBytes: number;
  readonly maxBodyAllocationBytes: number;
  readonly maxHeaderAllocationBytes: number;
  readonly maxMetadataAllocationBytes: number;
  readonly signal?: AbortSignal;
}

export type NetworkBodyCapture =
  | BrowserNetworkBody
  | {
      readonly state: "omitted";
      readonly reason: BrowserScenarioEventBudgetReason;
    };

export type NetworkBodyPreflight = (input: {
  readonly observedBytes: number;
  readonly allocationBytes: number;
  readonly mediaType: string | undefined;
}) => BrowserScenarioEventAdmission | Promise<BrowserScenarioEventAdmission>;

const errorMessage = (
  cause: unknown,
  secrets: BrowserScenarioSecrets,
  maxMetadataAllocationBytes: number,
  scope: ScenarioRedactionScope = "current",
): string => {
  const message =
    cause instanceof Error && cause.message !== ""
      ? cause.message
      : "Network read failed";
  return secrets.redactionAllocationCost(message.length, scope) <=
    maxMetadataAllocationBytes
    ? secrets.redact(message, scope)
    : "Network read failed; diagnostic exceeds the allocation budget.";
};

export type NetworkBodyRedaction = "json" | "unknown" | "bytes";

interface BodyMediaType {
  readonly value: string | null;
  readonly redaction: NetworkBodyRedaction;
  readonly declarationNames: readonly string[];
}

interface NetworkHeaderCapture {
  readonly headers: BrowserNetworkHeaders;
  readonly mediaType: BodyMediaType;
}

export const networkBodyMediaType = (
  value: string | null,
  declarationNames: readonly string[] = [CONTENT_TYPE_HEADER],
): BodyMediaType => ({
  value,
  declarationNames,
  redaction:
    value === null
      ? "unknown"
      : isJson(mediaTypeEssence(value))
        ? "json"
        : "bytes",
});

/** Publish only the type that can still be read after privacy projection. */
const retainNetworkMediaType = (
  { value, declarationNames }: BodyMediaType,
  secrets: BrowserScenarioSecrets,
  options: NetworkReadOptions,
): string | null => {
  if (value === null) return null;
  if (
    secrets.redactionAllocationCost(value.length, options.redactionScope) >
      options.maxHeaderAllocationBytes ||
    declarationNames.some(
      (name) => secrets.redact(name, options.redactionScope) !== name,
    ) ||
    secrets
      .redactBytes(Buffer.from(value), options.redactionScope)
      .toString("utf8") !== value
  )
    return null;
  return value;
};

/** Read actual producer headers without flattening duplicates or exposing credentials. */
export const captureNetworkHeaders = async (
  source: NetworkHeadersSource,
  retainValues: boolean,
  secrets: BrowserScenarioSecrets,
  options: NetworkReadOptions,
): Promise<NetworkHeaderCapture> => {
  const unavailable = (message: string): NetworkHeaderCapture => ({
    headers: retainValues
      ? { state: "unavailable", message }
      : { state: "not_requested" },
    mediaType: networkBodyMediaType(null),
  });
  try {
    const headers = await withPlaywrightExecutionBoundary(
      () => source.headersArray(),
      options.timeoutMs,
      options.signal,
    );
    let cost = 0;
    const items: Extract<
      BrowserNetworkHeaders,
      { state: "captured" }
    >["items"] = [];
    const declarations: string[] = [];
    const declarationNames: string[] = [];
    let typeRedacted = false;
    for (const { name, value } of headers) {
      const contentType = name.toLowerCase() === CONTENT_TYPE_HEADER;
      if (!retainValues && !contentType) continue;
      const credential = isTransportCredentialHeader(name);
      cost +=
        secrets.redactionAllocationCost(
          name.length + (credential ? 0 : value.length),
          options.redactionScope,
        ) + 128;
      if (cost > options.maxHeaderAllocationBytes)
        return unavailable(
          `Headers exceed the ${String(options.maxHeaderAllocationBytes)}-byte allocation budget.`,
        );
      if (contentType) {
        declarationNames.push(name);
        declarations.push(value);
      }
      if (!retainValues) continue;
      const safeName = secrets.redact(name, options.redactionScope);
      const safeValue = credential
        ? null
        : secrets
            .redactBytes(Buffer.from(value), options.redactionScope)
            .toString("utf8");
      const redacted = credential || safeName !== name || safeValue !== value;
      items.push({ name: safeName, value: safeValue, redacted });
      if (contentType) typeRedacted ||= redacted;
    }
    const observed = browserContentType(declarations);
    const mediaType = networkBodyMediaType(
      observed.state === "known" ? observed.value : null,
      declarationNames,
    );
    return {
      headers: retainValues
        ? { state: "captured", items }
        : { state: "not_requested" },
      mediaType: typeRedacted ? { ...mediaType, value: null } : mediaType,
    };
  } catch (cause: unknown) {
    return unavailable(
      errorMessage(
        cause,
        secrets,
        options.maxMetadataAllocationBytes,
        options.redactionScope,
      ),
    );
  }
};

/** Retain bytes returned by Playwright's body API, after declared-secret redaction. */
export const captureNetworkBody = async (
  read: () => Promise<Buffer | null>,
  phase: "request" | "response",
  getMediaType: () => BodyMediaType | Promise<BodyMediaType>,
  secrets: BrowserScenarioSecrets,
  options: NetworkReadOptions,
  preflight?: NetworkBodyPreflight,
  protection?: { readonly request: object; readonly retainBody: boolean },
): Promise<NetworkBodyCapture> => {
  try {
    const observed = await withPlaywrightExecutionBoundary(
      read,
      options.timeoutMs,
      options.signal,
    );
    if (observed === null) return { state: "not_exposed" };
    // This bounds subsequent redaction, base64 and validation copies, but the
    // Playwright API itself has already materialized the body (see PR limits).
    const maxBodyBytes = options.maxBodyBytes;
    if (observed.length > maxBodyBytes)
      return {
        state: "unavailable",
        reason: "body-size-limit",
        message: `Playwright materialized the body before its ${String(maxBodyBytes)}-byte retained-body budget was checked.`,
        limit_bytes: maxBodyBytes,
        observed_bytes: observed.length,
      };
    let sourceBody = observed;
    if (protection !== undefined) {
      sourceBody = secrets.admitResponseSecrets(
        protection.request,
        observed,
        protection.retainBody
          ? {
              maxBytes: options.maxBodyBytes,
              maxAllocationBytes: options.maxBodyAllocationBytes,
            }
          : undefined,
      );
      if (!protection.retainBody) return { state: "not_requested" };
    }
    const bodyAllocationCost = secrets.redactionAllocationCost(
      Math.max(observed.length, sourceBody.length),
      options.redactionScope,
    );
    const base64AllocationCost =
      Math.ceil(Math.max(observed.length, sourceBody.length) / 3) * 4 * 8 + 2;
    const maxBodyAllocationBytes = options.maxBodyAllocationBytes;
    const observedBodyAllocationBytes = Math.max(
      bodyAllocationCost,
      base64AllocationCost,
    );
    if (observedBodyAllocationBytes > maxBodyAllocationBytes)
      return {
        state: "unavailable",
        reason: "body-allocation-limit",
        message:
          "Body redaction exceeds the selected network body allocation budget.",
        limit_allocation_bytes: maxBodyAllocationBytes,
        observed_allocation_bytes: observedBodyAllocationBytes,
      };
    const mediaType = await getMediaType();
    const admission = await preflight?.({
      observedBytes: observed.length,
      allocationBytes: observedBodyAllocationBytes,
      mediaType: mediaType.value ?? undefined,
    });
    if (admission?.status === "omitted")
      return { state: "omitted", reason: admission.reason };
    let jsonBody = protection !== undefined;
    if (protection === undefined && mediaType.redaction !== "bytes") {
      const redacted = secrets.redactJsonBody(
        observed,
        {
          maxBytes: options.maxBodyBytes,
          maxAllocationBytes: options.maxBodyAllocationBytes,
        },
        options.redactionScope,
        mediaType.redaction,
      );
      sourceBody = redacted.bytes;
      jsonBody = redacted.json;
    }
    const retained = secrets.redactBytes(sourceBody, options.redactionScope);
    if (
      jsonBody &&
      !retained.equals(sourceBody) &&
      !safeParseJson(decodeStrictUtf8(retained, "preserve")).ok
    )
      return {
        state: "unavailable",
        reason: "body-read-failed",
        message:
          "Whole-body secret matching changed JSON syntax; the body was withheld.",
      };
    if (retained.length > maxBodyBytes)
      return {
        state: "unavailable",
        reason: "body-size-limit",
        message:
          "Secret redaction expanded the retained body beyond the selected byte limit.",
        limit_bytes: maxBodyBytes,
        observed_bytes: retained.length,
      };
    return {
      state: "captured",
      representation:
        phase === "request"
          ? "browser-exposed-request-bytes"
          : "playwright-response-body-bytes",
      encoding: "base64",
      content: retained.toString("base64"),
      bytes: retained.length,
      sha256: sha256Hex(retained),
      media_type: retainNetworkMediaType(mediaType, secrets, options),
      media_type_source: "content-type-header",
      redacted: !retained.equals(observed),
    };
  } catch (cause: unknown) {
    return {
      state: "unavailable",
      reason:
        cause instanceof AnalysisCancelledError
          ? "cancelled"
          : cause instanceof AnalysisTimeoutError
            ? "body-read-timeout"
            : "body-read-failed",
      message: errorMessage(
        cause,
        secrets,
        options.maxMetadataAllocationBytes,
        options.redactionScope,
      ),
    };
  }
};
