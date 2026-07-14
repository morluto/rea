import type { Evidence } from "../domain/evidence.js";
import type {
  InspectWebPageInput,
  ListBrowserTargetsInput,
} from "../domain/browserObservation.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisProtocolError,
  PermissionRequiredError,
  type AnalysisError,
} from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";
import type { ExecutionOptions } from "./AnalysisProvider.js";
import type { BrowserObservationPort } from "./BrowserObservationPort.js";
import type { PermissionAuthority } from "./PermissionAuthority.js";
import { createBrowserEvidence } from "./BrowserEvidence.js";

type ScopedBrowserInput = Pick<
  ListBrowserTargetsInput,
  "cdp_endpoint" | "allowed_origins"
> & { readonly target_id?: string };

/** Authorize and execute one policy-scoped target discovery observation. */
export const listBrowserTargets = async (
  browser: BrowserObservationPort | undefined,
  authority: PermissionAuthority | undefined,
  input: ListBrowserTargetsInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = await prepare(
    browser,
    authority,
    input,
    "list_browser_targets",
  );
  if (!ready.ok) return ready;
  const result = await ready.value.listTargets(input, options);
  return result.ok
    ? ok(
        createBrowserEvidence(
          "list_browser_targets",
          input,
          result.value,
          ready.value.identity(),
        ),
      )
    : result;
};

/** Authorize and execute one policy-scoped passive page inspection. */
export const inspectWebPage = async (
  browser: BrowserObservationPort | undefined,
  authority: PermissionAuthority | undefined,
  input: InspectWebPageInput,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const ready = await prepare(browser, authority, input, "inspect_web_page");
  if (!ready.ok) return ready;
  const result = await ready.value.inspectPage(input, options);
  return result.ok
    ? ok(
        createBrowserEvidence(
          "inspect_web_page",
          input,
          result.value,
          ready.value.identity(),
        ),
      )
    : result;
};

const prepare = async (
  browser: BrowserObservationPort | undefined,
  authority: PermissionAuthority | undefined,
  input: ScopedBrowserInput,
  operation: "list_browser_targets" | "inspect_web_page",
): Promise<Result<BrowserObservationPort, AnalysisError>> => {
  if (authority === undefined)
    return err(
      new AnalysisCapabilityUnavailableError(
        "rea-cdp-browser",
        operation,
        "browser observation permission policy is not configured",
      ),
    );
  const authorized = await authority.authorize(
    {
      capability: "browser_observe",
      roots: [],
      executables: [],
      environment_names: [],
      origins: [input.cdp_endpoint, ...input.allowed_origins],
      network: browserNetworkScope(input.allowed_origins),
      mount: false,
      operation_identity: `${operation}:${input.target_id ?? input.cdp_endpoint}`,
    },
    "read",
  );
  if (!authorized.ok)
    return err(
      authorized.error instanceof PermissionRequiredError
        ? authorized.error
        : new AnalysisProtocolError(authorized.error.message, {
            cause: authorized.error,
          }),
    );
  return browser === undefined
    ? err(
        new AnalysisCapabilityUnavailableError(
          "rea-cdp-browser",
          operation,
          "browser observation provider is not configured",
        ),
      )
    : ok(browser);
};

const browserNetworkScope = (
  allowedOrigins: readonly string[],
): "loopback" | "external" =>
  allowedOrigins.every((origin) => {
    const hostname = new URL(origin).hostname;
    return hostname === "127.0.0.1" || hostname === "[::1]";
  })
    ? "loopback"
    : "external";
