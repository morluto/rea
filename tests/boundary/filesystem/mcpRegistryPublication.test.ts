import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
  classifyReadFailure,
  registryPublicationState,
} from "../../../.github/actions/publish-mcp/registry-state.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const runNode = promisify(execFile);
const scriptPath = fileURLToPath(
  new URL(
    "../../../.github/actions/publish-mcp/registry-state.mjs",
    import.meta.url,
  ),
);

const server = {
  name: "io.github.fixture/rea",
  version: "6.5.0",
  description: "Released metadata",
};
const record = {
  server,
  _meta: { "io.modelcontextprotocol.registry/official": { status: "active" } },
};
const page = (servers: unknown[], metadata = {}) =>
  Response.json({ servers, metadata });
const noSleep = async () => {};
const timeoutError = () =>
  new DOMException("The operation was aborted due to timeout", "TimeoutError");

it("finds an identical existing version after paging past substring matches", async () => {
  const urls: URL[] = [];
  const result = await registryPublicationState(server, async (url: URL) => {
    urls.push(url);
    return urls.length === 1
      ? page([{ server: { ...server, name: `${server.name}-other` } }], {
          nextCursor: "next",
        })
      : page([record]);
  });
  expect(result).toBe("present");
  expect(urls[0]?.searchParams.get("search")).toBe(server.name);
  expect(urls[0]?.searchParams.get("version")).toBe(server.version);
  expect(urls[0]?.searchParams.get("include_deleted")).toBe("true");
  expect(urls[1]?.searchParams.get("cursor")).toBe("next");
});

it("permits publication only after a complete successful lookup finds no exact match", async () => {
  await expect(
    registryPublicationState(server, async () => page([])),
  ).resolves.toBe("absent");
  await expect(
    registryPublicationState(
      server,
      async () => new Response("unavailable", { status: 503 }),
      { sleep: noSleep },
    ),
  ).rejects.toThrow("HTTP 503");
  await expect(
    registryPublicationState(server, async () =>
      Response.json({ metadata: {} }),
    ),
  ).rejects.toThrow("omitted servers");
  await expect(
    registryPublicationState(server, async () =>
      page([], { nextCursor: "same" }),
    ),
  ).rejects.toThrow("non-advancing cursor");
});

it("refuses changed, inactive or ambiguous published metadata", async () => {
  await expect(
    registryPublicationState(server, async () =>
      page([{ ...record, server: { ...server, description: "Different" } }]),
    ),
  ).rejects.toThrow("differs from released metadata");
  await expect(
    registryPublicationState(server, async () =>
      page([
        {
          ...record,
          _meta: {
            "io.modelcontextprotocol.registry/official": { status: "deleted" },
          },
        },
      ]),
    ),
  ).rejects.toThrow("not active");
  await expect(
    registryPublicationState(server, async () => page([record, record])),
  ).rejects.toThrow("ambiguous");
});

it("retries a timed-out lookup with bounded backoff and then succeeds", async () => {
  const delays: number[] = [];
  let calls = 0;
  const result = await registryPublicationState(
    server,
    async () => {
      calls += 1;
      if (calls <= 2) throw timeoutError();
      return page([]);
    },
    {
      sleep: async (ms: number) => {
        delays.push(ms);
      },
    },
  );
  expect(result).toBe("absent");
  expect(calls).toBe(3);
  expect(delays).toEqual([5_000, 15_000]);
});

it("keeps the state unknown when every attempt times out", async () => {
  let calls = 0;
  await expect(
    registryPublicationState(
      server,
      async () => {
        calls += 1;
        throw timeoutError();
      },
      { sleep: noSleep },
    ),
  ).rejects.toMatchObject({ name: "TimeoutError" });
  expect(calls).toBe(3);
});

it("does not retry a 404 response", async () => {
  let calls = 0;
  await expect(
    registryPublicationState(
      server,
      async () => {
        calls += 1;
        return new Response("missing", { status: 404 });
      },
      { sleep: noSleep },
    ),
  ).rejects.toThrow("HTTP 404");
  expect(calls).toBe(1);
});

it("classifies registry read failures", async () => {
  expect(classifyReadFailure(timeoutError())).toBe("timeout");
  expect(classifyReadFailure(new TypeError("fetch failed"))).toBe(
    "network_error",
  );
  expect(classifyReadFailure(new Error("other"))).toBe("other");
  const serverError = await registryPublicationState(
    server,
    async () => new Response("down", { status: 503 }),
    { sleep: noSleep },
  ).catch((error: unknown) => error);
  expect(classifyReadFailure(serverError)).toBe("server_error");
  const notFound = await registryPublicationState(
    server,
    async () => new Response("missing", { status: 404 }),
    { sleep: noSleep },
  ).catch((error: unknown) => error);
  expect(classifyReadFailure(notFound)).toBe("not_found");
});

it("cancels a failed response body before retrying", async () => {
  const events: string[] = [];
  let calls = 0;
  const result = await registryPublicationState(
    server,
    async () => {
      calls += 1;
      if (calls === 1) {
        events.push("request 1");
        const body = new ReadableStream({
          cancel() {
            events.push("body cancelled");
          },
        });
        return new Response(body, { status: 503 });
      }
      events.push("request 2");
      return page([]);
    },
    { sleep: noSleep },
  );
  expect(result).toBe("absent");
  expect(events).toEqual(["request 1", "body cancelled", "request 2"]);
});

it("keeps the original registry error when the job summary cannot be written", async () => {
  const dir = await createTestTempDirectory("rea-registry-state-");
  // No server.json here, so the step fails before any network call.
  // The summary path is a directory, so writing the summary fails too.
  const failure = await runNode(process.execPath, [scriptPath], {
    cwd: dir,
    env: {
      ...process.env,
      GITHUB_STEP_SUMMARY: dir,
      GITHUB_OUTPUT: join(dir, "output.txt"),
    },
  }).then(
    () => undefined,
    (error: unknown) => error as { code?: number; stderr?: string },
  );
  expect(failure).toBeDefined();
  expect(failure?.code).not.toBe(0);
  expect(failure?.stderr).toContain("server.json");
}, 20_000);
