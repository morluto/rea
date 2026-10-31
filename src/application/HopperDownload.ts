/** Download result; HTTP failures may carry their observed status for diagnostics. */
export interface HopperDownload {
  readonly ok: boolean;
  readonly bytes: Uint8Array;
  readonly httpStatus?: number;
}

/** Maximum admitted vendor response bytes, shared by Hopper setup adapters. */
export const HOPPER_DOWNLOAD_BYTES = 100_000_000;

/** Longest wait for the response or its next bytes before a download stalls. */
export const HOPPER_DOWNLOAD_STALL_MS = 30_000;

/**
 * Overall bound for one download. A slow connection that keeps delivering
 * bytes is bounded here rather than by a deadline sized for fast networks.
 */
export const HOPPER_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

/** Small release feed and key requests must not use the package bounds. */
export const HOPPER_METADATA_TIMEOUT_MS = 10_000;

/** A Hopper download that stalled or outlived its overall bound. */
export class HopperDownloadTimeoutError extends Error {
  readonly _tag = "HopperDownloadTimeoutError";
  constructor(
    readonly limit: "stalled" | "deadline",
    readonly url: string,
    readonly limitMs: number,
    readonly receivedBytes: number,
  ) {
    const seconds = String(limitMs / 1000);
    super(
      limit === "stalled"
        ? `No response bytes arrived for ${seconds} s from ${url}; ${String(receivedBytes)} bytes were received before the download stalled.`
        : `The download from ${url} did not finish within ${seconds} s; ${String(receivedBytes)} bytes were received.`,
    );
    this.name = "HopperDownloadTimeoutError";
  }
}

/** Bound observed response bytes before retaining them, including chunked bodies. */
export const downloadHopperPackage = async (
  url: string,
  options: {
    readonly signal?: AbortSignal;
    readonly maxBytes?: number;
    /** Overall bound; a stall bound applies only when it is shorter. */
    readonly timeoutMs?: number;
  } = {},
): Promise<HopperDownload> => {
  const timeoutMs = options.timeoutMs ?? HOPPER_DOWNLOAD_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > HOPPER_DOWNLOAD_TIMEOUT_MS
  )
    throw new RangeError("Invalid Hopper response time budget");
  const maxBytes = options.maxBytes ?? HOPPER_DOWNLOAD_BYTES;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > HOPPER_DOWNLOAD_BYTES
  )
    throw new RangeError("Invalid Hopper response byte budget");
  let bytes = 0;
  const deadline = new AbortController();
  const expire = (limit: "stalled" | "deadline", limitMs: number) => {
    deadline.abort(new HopperDownloadTimeoutError(limit, url, limitMs, bytes));
  };
  const overall = setTimeout(() => {
    expire("deadline", timeoutMs);
  }, timeoutMs);
  let stall: NodeJS.Timeout | undefined;
  const progressed = () => {
    if (HOPPER_DOWNLOAD_STALL_MS >= timeoutMs) return;
    clearTimeout(stall);
    stall = setTimeout(() => {
      expire("stalled", HOPPER_DOWNLOAD_STALL_MS);
    }, HOPPER_DOWNLOAD_STALL_MS);
  };
  try {
    progressed();
    const response = await fetchHopperResponse(
      url,
      options.signal === undefined
        ? deadline.signal
        : AbortSignal.any([options.signal, deadline.signal]),
    );
    const refused = { ok: false, bytes: new Uint8Array() };
    if (response === undefined) return refused;
    if (!response.ok) {
      await response.body?.cancel();
      return Number.isInteger(response.status) &&
        response.status >= 300 &&
        response.status <= 599
        ? { ...refused, httpStatus: response.status }
        : refused;
    }
    if (Number(response.headers.get("content-length")) > maxBytes) {
      await response.body?.cancel();
      return refused;
    }
    if (response.body === null) return { ok: true, bytes: new Uint8Array() };
    progressed();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done)
          return { ok: true, bytes: Buffer.concat(chunks, bytes) };
        if (chunk.value.byteLength > maxBytes - bytes) {
          await reader.cancel();
          return refused;
        }
        chunks.push(chunk.value);
        bytes += chunk.value.byteLength;
        if (chunk.value.byteLength > 0) progressed();
      }
    } finally {
      reader.releaseLock();
    }
  } finally {
    clearTimeout(overall);
    clearTimeout(stall);
  }
};

// HTTP-redirect fetch admits at most 20 redirects; retain that existing Fetch
// bound while checking each destination before the next request.
const FETCH_REDIRECT_LIMIT = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const fetchHopperResponse = async (
  url: string,
  signal: AbortSignal,
): Promise<Response | undefined> => {
  let selected: URL;
  try {
    selected = new URL(url);
  } catch {
    return undefined;
  }
  let requested = url;
  for (let redirects = 0; ; redirects++) {
    if (selected.protocol !== "https:") return undefined;
    const response = await fetch(requested, {
      redirect: "manual",
      headers: { accept: "application/json", "user-agent": "rea-installer" },
      signal,
    });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (location === null || redirects === FETCH_REDIRECT_LIMIT)
      return undefined;
    let next: URL;
    try {
      next = new URL(location, selected);
    } catch {
      return undefined;
    }
    // Fetch inherits the previous fragment when Location has none.
    if (!location.includes("#")) next.hash = selected.hash;
    selected = next;
    requested = next.href;
  }
};
