import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RETRY_DELAYS_MS = [5_000, 15_000];
const RETRYABLE_KINDS = new Set(["timeout", "network_error", "server_error"]);
const defaultSleep = (ms) => new Promise((done) => setTimeout(done, ms));

class RegistryReadError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = "RegistryReadError";
    this.kind = kind;
  }
}

/** Names why a registry read failed, so reruns can tell "degraded" from "route changed". */
export function classifyReadFailure(error) {
  if (error instanceof RegistryReadError) return error.kind;
  if (error?.name === "TimeoutError") return "timeout";
  if (error instanceof TypeError) return "network_error";
  return "other";
}

async function readPage(url, request, { delaysMs, sleep }) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await request(url, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        // Release the connection before a retry; an unread error body can keep it busy.
        await response.body?.cancel().catch(() => {});
        const kind =
          response.status >= 500
            ? "server_error"
            : response.status === 404
              ? "not_found"
              : "http_error";
        throw new RegistryReadError(
          kind,
          `Registry lookup failed: HTTP ${response.status}`,
        );
      }
      return await response.json();
    } catch (error) {
      const retryable = RETRYABLE_KINDS.has(classifyReadFailure(error));
      if (!retryable || attempt >= delaysMs.length) throw error;
      await sleep(delaysMs[attempt]);
    }
  }
}

/** Exact-version routes currently return false 404s; enumerate the filtered listing. */
export async function registryPublicationState(
  server,
  request = fetch,
  { retryDelaysMs = RETRY_DELAYS_MS, sleep = defaultSleep } = {},
) {
  assert.equal(typeof server?.name, "string");
  assert.equal(typeof server?.version, "string");
  const cursors = new Set();
  let cursor;
  const matches = [];
  do {
    const url = new URL(
      "https://registry.modelcontextprotocol.io/v0.1/servers",
    );
    url.search = new URLSearchParams({
      search: server.name,
      version: server.version,
      include_deleted: "true",
      limit: "100",
    }).toString();
    if (cursor !== undefined) url.searchParams.set("cursor", cursor);
    const page = await readPage(url, request, {
      delaysMs: retryDelaysMs,
      sleep,
    });
    assert(Array.isArray(page?.servers), "Registry response omitted servers");
    assert(
      page.metadata && typeof page.metadata === "object",
      "Registry response omitted metadata",
    );
    for (const entry of page.servers) {
      assert(
        typeof entry?.server?.name === "string" &&
          typeof entry.server.version === "string",
        "Malformed registry server record",
      );
      if (
        entry.server.name === server.name &&
        entry.server.version === server.version
      )
        matches.push(entry);
    }
    cursor = page.metadata.nextCursor;
    if (cursor !== undefined) {
      assert(
        typeof cursor === "string" && cursor.length > 0 && !cursors.has(cursor),
        "Registry returned a non-advancing cursor",
      );
      cursors.add(cursor);
    }
  } while (cursor !== undefined);
  assert(
    matches.length <= 1,
    "Registry returned ambiguous exact-version records",
  );
  if (matches.length === 0) return "absent";
  assert.equal(
    matches[0]._meta?.["io.modelcontextprotocol.registry/official"]?.status,
    "active",
    "Existing registry version is not active",
  );
  assert.deepEqual(
    matches[0].server,
    server,
    "Existing registry version differs from released metadata",
  );
  return "present";
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let state;
  try {
    state = await registryPublicationState(
      JSON.parse(await readFile("server.json", "utf8")),
    );
  } catch (error) {
    if (process.env.GITHUB_STEP_SUMMARY) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await appendFile(
          process.env.GITHUB_STEP_SUMMARY,
          `### MCP Registry read failed\n\nFailure kind: \`${classifyReadFailure(error)}\`\n\n${message}\n`,
        );
      } catch {
        // The summary is best effort; keep the original registry error below.
      }
    }
    throw error; // unknown stays unknown: the job still fails
  }
  assert(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT is required");
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `exists=${state === "present"}\n`,
  );
  process.stdout.write(
    `Registry version is ${state}; ${state === "present" ? "preserving identical published metadata" : "publication may proceed"}.\n`,
  );
}
