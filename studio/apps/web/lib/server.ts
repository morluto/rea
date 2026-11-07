import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { studioHome, StudioStore } from "@rea-studio/core";

const globalStore = globalThis as { __reaStudioStore?: StudioStore };

/** One store per server process, reused across hot reloads. */
export const getStore = (): StudioStore => {
  globalStore.__reaStudioStore ??= new StudioStore();
  return globalStore.__reaStudioStore;
};

export { isAllowedHost } from "./request-policy";
import { isAllowedHost } from "./request-policy";

export const json = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });

/**
 * Guard every API route: allowed Host only, and mutating requests must not
 * come from another origin (CSRF). Returns a response when refused.
 */
export const guard = (request: Request): Response | undefined => {
  const host = request.headers.get("host");
  if (!isAllowedHost(host)) {
    return json({ error: "This host is not allowed to reach Reall." }, 403);
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    const origin = request.headers.get("origin");
    if (origin !== null) {
      let originHost = "";
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = "";
      }
      if (originHost !== host) {
        return json({ error: "Cross-origin requests are refused." }, 403);
      }
    }
  }
  return undefined;
};

export const badRequest = (message: string): Response =>
  json({ error: message }, 400);
export const notFoundJson = (): Response => json({ error: "Not found." }, 404);

/** Last time the worker reported in, if it ever did. */
export const workerHeartbeat = (): Date | undefined => {
  try {
    const path = join(studioHome(), "worker.heartbeat");
    statSync(path);
    return new Date(readFileSync(path, "utf8").trim());
  } catch {
    return undefined;
  }
};

export const errorText = (cause: unknown): string => {
  if (
    cause &&
    typeof cause === "object" &&
    "issues" in cause &&
    Array.isArray(cause.issues)
  ) {
    return cause.issues
      .map(
        (issue: { path?: unknown[]; message?: string }) =>
          `${(issue.path ?? []).join(".") || "input"}: ${issue.message ?? "invalid"}`,
      )
      .join("; ");
  }
  return cause instanceof Error ? cause.message : String(cause);
};
