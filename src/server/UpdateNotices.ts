import { gt, valid } from "semver";

import { PRODUCT_IDENTITY } from "../identity.js";
import { err, ok, type Result } from "../domain/result.js";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const LOOKUP_TIMEOUT_MS = 5_000;
// Only dist-tags are requested, never the package's growing release history.
const MAX_TAG_BYTES = 16 * 1_024;

export type ReleaseLookup = (
  signal: AbortSignal,
) => Promise<Result<string, "unavailable" | "invalid-metadata">>;

/** Fetch public release metadata without sending target, client, or session data. */
export const lookupLatestRelease: ReleaseLookup = async (signal) => {
  try {
    const response = await fetch(
      `https://registry.npmjs.org/-/package/${PRODUCT_IDENTITY.packageName}/dist-tags`,
      { signal, redirect: "error", headers: { accept: "application/json" } },
    );
    if (!response.ok || response.body === null) {
      await response.body?.cancel();
      return err("unavailable");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.byteLength > MAX_TAG_BYTES - size) {
          await reader.cancel();
          return err("invalid-metadata");
        }
        size += value.byteLength;
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const metadata: unknown = JSON.parse(
      Buffer.concat(chunks, size).toString("utf8"),
    );
    const latest =
      typeof metadata === "object" && metadata !== null
        ? Reflect.get(metadata, "latest")
        : undefined;
    return typeof latest === "string" && valid(latest) !== null
      ? ok(latest)
      : err("invalid-metadata");
  } catch {
    return err("unavailable");
  }
};

/** One connection owns its lookup, cache, cancellation and attempted notices. */
export class UpdateNotices {
  private pending: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private checkedAt: number | undefined;
  private latest:
    { readonly version: string; readonly observedAt: number } | undefined;
  private readonly announced = new Set<string>();
  private closed = false;

  constructor(
    private readonly current: string = PRODUCT_IDENTITY.packageVersion,
    private readonly lookup: ReleaseLookup = lookupLatestRelease,
    private readonly now: () => number = Date.now,
  ) {}

  /** Never await release discovery in the tool request path. Failures also back off. */
  refresh(): void {
    if (this.closed || this.pending !== undefined) return;
    const now = this.now();
    if (
      this.checkedAt !== undefined &&
      now - this.checkedAt < CHECK_INTERVAL_MS
    )
      return;
    this.checkedAt = now;
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
    timeout.unref();
    this.pending = Promise.resolve()
      .then(() => this.lookup(controller.signal))
      .then((result) => {
        if (this.closed || controller.signal.aborted) return;
        if (!result.ok || valid(result.value) === null) return;
        this.latest = gt(result.value, this.current)
          ? { version: result.value, observedAt: this.now() }
          : undefined;
      })
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timeout);
        this.controller = undefined;
        this.pending = undefined;
      });
  }

  peek(): { readonly version: string; readonly text: string } | undefined {
    const observation = this.latest;
    if (
      this.closed ||
      observation === undefined ||
      this.announced.has(observation.version)
    )
      return undefined;
    const { version, observedAt } = observation;
    return {
      version,
      text: `REA update available: running ${this.current}; latest published ${version} as observed at ${new Date(observedAt).toISOString()} (the registry may have changed). Tell the user. To update a global installation, run rea update; update source checkouts or pinned package-runner registrations through their owning mechanism. After updating, restart/reconnect the MCP client to load the new version. This notice does not establish the version currently installed on disk. Do not install automatically.`,
    };
  }

  /** Mark before transport send: a rejected send may still have reached the client. */
  acknowledge(version: string): void {
    this.announced.add(version);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.controller?.abort();
    await this.pending;
  }
}

/** Networking is explicitly opt-in; omission, 0 and unknown values stay offline. */
export const configuredUpdateNoticeFactory = (
  environment: Readonly<NodeJS.ProcessEnv>,
): (() => UpdateNotices) | undefined =>
  environment.REA_MCP_UPDATE_CHECK === "1"
    ? () => new UpdateNotices()
    : undefined;
