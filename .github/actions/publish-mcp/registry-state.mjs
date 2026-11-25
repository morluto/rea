import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function readRegistryPage(page) {
  assert(Array.isArray(page?.servers), "Registry response omitted servers");
  const { servers, metadata } = page;
  assert(
    metadata && typeof metadata === "object" && !Array.isArray(metadata),
    "Registry response omitted or malformed metadata",
  );
  if (metadata.count !== undefined)
    assert.equal(
      metadata.count,
      servers.length,
      "Registry page count does not match its server records",
    );
  const cursor = metadata.nextCursor ?? "";
  assert(typeof cursor === "string", "Registry returned an invalid cursor");
  return { servers, nextCursor: cursor || undefined };
}

/** Exact-version routes currently return false 404s; enumerate the filtered listing. */
export async function registryPublicationState(server, request = fetch) {
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
    const response = await request(url, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(`Registry lookup failed: HTTP ${response.status}`);
    const { servers, nextCursor } = readRegistryPage(await response.json());
    for (const entry of servers) {
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
    cursor = nextCursor;
    if (cursor !== undefined) {
      assert(!cursors.has(cursor), "Registry returned a non-advancing cursor");
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
  const state = await registryPublicationState(
    JSON.parse(await readFile("server.json", "utf8")),
  );
  assert(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT is required");
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `exists=${state === "present"}\n`,
  );
  process.stdout.write(
    `Registry version is ${state}; ${state === "present" ? "preserving identical published metadata" : "publication may proceed"}.\n`,
  );
}
