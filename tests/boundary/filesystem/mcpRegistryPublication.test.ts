import { expect, it } from "vitest";
import { registryPublicationState } from "../../../.github/actions/publish-mcp/registry-state.mjs";

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
  Response.json({ servers, metadata: { count: servers.length, ...metadata } });

it("finds an identical existing version after paging past substring matches", async () => {
  const urls: URL[] = [];
  const nextCursor = " next+/=";
  const result = await registryPublicationState(server, async (url: URL) => {
    urls.push(url);
    return urls.length === 1
      ? page([{ server: { ...server, name: `${server.name}-other` } }], {
          nextCursor,
        })
      : page([record]);
  });
  expect(result).toBe("present");
  expect(urls[0]?.searchParams.get("search")).toBe(server.name);
  expect(urls[0]?.searchParams.get("version")).toBe(server.version);
  expect(urls[0]?.searchParams.get("include_deleted")).toBe("true");
  expect(urls[1]?.searchParams.get("cursor")).toBe(nextCursor);
});

it.each([undefined, null, ""])(
  "treats a terminal cursor of %j as the final page",
  async (nextCursor) => {
    await expect(
      registryPublicationState(server, async () =>
        Response.json({ servers: [], metadata: { nextCursor } }),
      ),
    ).resolves.toBe("absent");
  },
);

it("does not establish absence when a page cannot be verified", async () => {
  await expect(
    registryPublicationState(
      server,
      async () => new Response("unavailable", { status: 503 }),
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

it.each([
  { metadata: [], error: "metadata" },
  { metadata: { count: 1 }, error: "count" },
  { metadata: { count: "0" }, error: "count" },
  { metadata: { nextCursor: 0 }, error: "invalid cursor" },
])(
  "rejects a terminal page with invalid $error ($metadata)",
  async ({ metadata, error }) => {
    await expect(
      registryPublicationState(server, async () =>
        Response.json({ servers: [], metadata }),
      ),
    ).rejects.toThrow(error);
  },
);

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
