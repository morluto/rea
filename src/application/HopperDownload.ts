import { sanitizeBrowserUrl } from "../domain/browserObservation.js";
import { err, ok, type Result } from "../domain/result.js";

/** Why a URL was refused before any vendor response could be admitted. */
export type HopperUrlRefusal =
  | "invalid_url"
  | "non_https"
  | "credentials"
  | "redirect_without_location"
  | "redirect_limit";

/**
 * Transport facts for one Hopper request that yielded no admitted bytes.
 * `url` is the caller-selected request with any URL userinfo removed, never a
 * redirect target. URLs carrying credentials are refused before any request,
 * so no transport detail can contain them.
 */
export type HopperDownloadFailure = { readonly url: string } & (
  | {
      readonly kind: "http_status";
      /** Absent when the response did not carry a valid HTTP failure status. */
      readonly httpStatus?: number;
    }
  | { readonly kind: "timeout"; readonly timeoutMs: number }
  | { readonly kind: "network"; readonly detail: string }
  | { readonly kind: "response_too_large"; readonly maxBytes: number }
  | { readonly kind: "url_refused"; readonly refusal: HopperUrlRefusal }
);

/** Admitted response bytes, or the observed reason none were admitted. */
export type HopperDownload = Result<Uint8Array, HopperDownloadFailure>;

/** The vendor request a Hopper workflow made; identifies the failed stage. */
export type HopperVendorRequest = "release_feed" | "package" | "public_key";

/** A failed download attributed to the workflow stage that requested it. */
export type HopperRequestFailure = HopperDownloadFailure & {
  readonly request: HopperVendorRequest;
};

/** Maximum admitted vendor response bytes, shared by Hopper setup adapters. */
export const HOPPER_DOWNLOAD_BYTES = 100_000_000;

/**
 * Bound observed response bytes before retaining them, including chunked bodies.
 * Expected transport outcomes are returned; caller cancellation still rejects
 * with the caller's abort reason so cancellation stays distinct from failure.
 */
export const downloadHopperPackage = async (
  url: string,
  options: {
    readonly signal?: AbortSignal;
    readonly maxBytes?: number;
    readonly timeoutMs?: number;
  } = {},
): Promise<HopperDownload> => {
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new RangeError("Invalid Hopper response time budget");
  const maxBytes = options.maxBytes ?? HOPPER_DOWNLOAD_BYTES;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > HOPPER_DOWNLOAD_BYTES
  )
    throw new RangeError("Invalid Hopper response byte budget");
  const deadline = AbortSignal.timeout(timeoutMs);
  // Remove transport credentials once, where every failure is created.
  const reported = sanitizeBrowserUrl(url).url;
  try {
    return await readHopperResponse(
      url,
      reported,
      options.signal === undefined
        ? deadline
        : AbortSignal.any([options.signal, deadline]),
      maxBytes,
    );
  } catch (cause: unknown) {
    if (options.signal?.aborted === true) throw cause;
    if (deadline.aborted)
      return err({ url: reported, kind: "timeout", timeoutMs });
    // Fetch reports network errors (DNS, TLS, reset, truncated body) as TypeError.
    if (cause instanceof TypeError)
      return err({
        url: reported,
        kind: "network",
        detail: networkDetail(cause),
      });
    throw cause;
  }
};

const readHopperResponse = async (
  requested: string,
  url: string,
  signal: AbortSignal,
  maxBytes: number,
): Promise<HopperDownload> => {
  const fetched = await fetchHopperResponse(requested, signal);
  if (!fetched.ok)
    return err({ url, kind: "url_refused", refusal: fetched.error });
  const response = fetched.value;
  if (!response.ok) {
    await releaseBody(response.body);
    return err(
      Number.isInteger(response.status) &&
        response.status >= 300 &&
        response.status <= 599
        ? { url, kind: "http_status", httpStatus: response.status }
        : { url, kind: "http_status" },
    );
  }
  const tooLarge = { url, kind: "response_too_large", maxBytes } as const;
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await releaseBody(response.body);
    return err(tooLarge);
  }
  if (response.body === null) return ok(new Uint8Array());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return ok(Buffer.concat(chunks, bytes));
      if (chunk.value.byteLength > maxBytes - bytes) {
        await releaseBody(reader);
        return err(tooLarge);
      }
      chunks.push(chunk.value);
      bytes += chunk.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
};

/**
 * Release a body REA will not admit. A stream that already failed (for example
 * a truncated error body) has nothing left to release, and its error must not
 * replace the response outcome that was already observed.
 */
const releaseBody = async (
  body: { cancel(): Promise<void> } | null,
): Promise<void> => {
  try {
    await body?.cancel();
  } catch (cause: unknown) {
    // best-effort cleanup: an errored stream is already released.
    void cause;
  }
};

const networkDetail = (cause: TypeError): string => {
  const underlying = cause.cause instanceof Error ? cause.cause.message : "";
  return underlying === "" || underlying === cause.message
    ? cause.message
    : `${cause.message}: ${underlying}`;
};

// HTTP-redirect fetch admits at most 20 redirects; retain that existing Fetch
// bound while checking each destination before the next request.
const FETCH_REDIRECT_LIMIT = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const fetchHopperResponse = async (
  url: string,
  signal: AbortSignal,
): Promise<Result<Response, HopperUrlRefusal>> => {
  let selected: URL;
  try {
    selected = new URL(url);
  } catch {
    return err("invalid_url");
  }
  let requested = url;
  for (let redirects = 0; ; redirects++) {
    if (selected.protocol !== "https:") return err("non_https");
    // Fetch cannot request userinfo and would echo it in its TypeError message.
    if (selected.username !== "" || selected.password !== "")
      return err("credentials");
    const response = await fetch(requested, {
      redirect: "manual",
      headers: { accept: "application/json", "user-agent": "rea-installer" },
      signal,
    });
    if (!REDIRECT_STATUSES.has(response.status)) return ok(response);
    const location = response.headers.get("location");
    await releaseBody(response.body);
    if (location === null) return err("redirect_without_location");
    if (redirects === FETCH_REDIRECT_LIMIT) return err("redirect_limit");
    let next: URL;
    try {
      next = new URL(location, selected);
    } catch {
      return err("invalid_url");
    }
    // Fetch inherits the previous fragment when Location has none.
    if (!location.includes("#")) next.hash = selected.hash;
    selected = next;
    requested = next.href;
  }
};

const requestSubjects: Readonly<Record<HopperVendorRequest, string>> = {
  release_feed: "Hopper release feed",
  package: "Hopper package",
  public_key: "Hopper public key",
};

const refusals: Readonly<Record<HopperUrlRefusal, string>> = {
  invalid_url: "a request or redirect URL was not a valid absolute URL",
  non_https: "a request or redirect URL did not use HTTPS",
  credentials: "a request or redirect URL contained credentials",
  redirect_without_location: "a redirect response omitted its Location",
  redirect_limit: `the response redirected more than ${FETCH_REDIRECT_LIMIT} times`,
};

/** One sentence naming the failed request, its URL and the observed outcome. */
export const describeHopperRequestFailure = (
  failure: HopperRequestFailure,
): string => {
  const subject = `The official ${requestSubjects[failure.request]} request to ${failure.url}`;
  switch (failure.kind) {
    case "http_status":
      return failure.httpStatus === undefined
        ? `${subject} received an unsuccessful HTTP response without a valid status.`
        : `${subject} returned HTTP ${failure.httpStatus}.`;
    case "timeout":
      return `${subject} did not complete within ${failure.timeoutMs / 1000} seconds.`;
    case "network":
      return `${subject} failed with a network error (${failure.detail}).`;
    case "response_too_large":
      return `${subject} exceeded REA's ${failure.maxBytes}-byte response limit.`;
    case "url_refused":
      return `${subject} was refused because ${refusals[failure.refusal]}.`;
  }
};

/** Next step for a failed request, owned with the transport facts that select it. */
export const hopperRequestRecovery = (
  failure: HopperDownloadFailure,
): string => {
  switch (failure.kind) {
    case "http_status": {
      const status = failure.httpStatus;
      if (status === 404 || status === 410)
        return "The vendor reports this file as missing, so an immediate retry is unlikely to help; check for a newer REA release, then retry.";
      if (
        status === 408 ||
        status === 429 ||
        (status !== undefined && status >= 500)
      )
        return "The vendor service reported a temporary failure; wait, then retry.";
      return "Check proxy, firewall or network policy for this request, then retry.";
    }
    case "timeout":
    case "network":
      return "Check network, DNS, proxy and TLS access to this URL, then retry.";
    case "response_too_large":
    case "url_refused":
      return "The vendor response did not meet REA's download limits; check for a newer REA release, then retry.";
  }
};
