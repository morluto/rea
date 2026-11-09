import { mkdir, writeFile } from "node:fs/promises";
import { request, type IncomingHttpHeaders } from "node:http";
import { join } from "node:path";

import { expect, it, onTestFinished, vi } from "vitest";

import { verifyPackageUpdate } from "../../../scripts/verify-package-update.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

interface HttpReply {
  readonly status: number | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

const httpRequest = (
  registry: URL,
  target: string,
  method: string,
): Promise<HttpReply> =>
  new Promise((resolve, reject) => {
    const pending = request(
      {
        hostname: registry.hostname,
        port: registry.port,
        path: target,
        method,
        timeout: 3_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    pending.on("error", reject);
    pending.on("timeout", () =>
      pending.destroy(new Error("Registry fixture response timed out")),
    );
    pending.end();
  });

/** Exercise the actual HTTP owner without installing or launching a package. */
const registryRequest = async (
  target: string,
  method = "GET",
  upstreamFailure?: Error,
): Promise<HttpReply> => {
  const root = await createTestTempDirectory("rea-registry-http-");
  const packageRoot = join(root, "package");
  const tarball = join(root, "release.tgz");
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await Promise.all([
    writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "rea-agents", version: "6.0.0" }),
    ),
    writeFile(
      join(packageRoot, "dist", "generatedPackageMetadata.js"),
      'export const generated = { version: "6.0.0" };\n',
    ),
    writeFile(tarball, "archive"),
  ]);
  const finished = new Error("HTTP observation completed");
  let reply: HttpReply | undefined;
  // Assertions run after the owner settles: its retained upstream failure must
  // never swallow a failed assertion inside the command callback.
  await expect(
    verifyPackageUpdate({
      prefix: join(root, "prefix"),
      packageRoot,
      tarball,
      workspace: root,
      environment: {},
      commands: {
        async exec(_command, _arguments, options) {
          const selected = options?.env?.npm_config_registry;
          if (selected === undefined)
            throw new Error("Verifier did not select its local registry");
          reply = await httpRequest(new URL(selected), target, method);
          throw finished;
        },
      },
    }),
  ).rejects.toBe(upstreamFailure ?? finished);
  if (reply === undefined)
    throw new Error("Registry response was not observed");
  return reply;
};

it.each([
  ["/unlisted?x=a%20b&x=2", "/unlisted?x=a%20b&x=2"],
  ["http://other.invalid:9999/unlisted?x=%2F", "/unlisted?x=%2F"],
  ["//other.invalid/unlisted?x=1", "//other.invalid/unlisted?x=1"],
  ["//other.invalid/rea-agents?x=1", "//other.invalid/rea-agents?x=1"],
  ["/%40scope%2fpackage?escaped=%252f", "/%40scope%2fpackage?escaped=%252f"],
])(
  "forwards %s to the fixed npm origin with its path and query",
  async (target, path) => {
    const destinations: string[] = [];
    const upstream = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        destinations.push(input instanceof Request ? input.url : String(input));
        return new Response("upstream body", {
          status: 206,
          headers: { "content-type": "application/json" },
        });
      });
    onTestFinished(() => upstream.mockRestore());

    const reply = await registryRequest(target);

    expect(destinations).toEqual([`https://registry.npmjs.org${path}`]);
    expect(reply).toMatchObject({
      status: 206,
      headers: { "content-type": "application/json" },
      body: "upstream body",
    });
  },
);

it.each([
  ["GET", "http://other.invalid/rea-agents", "metadata"],
  ["GET", "/release.tgz", "archive"],
  ["POST", "/unlisted", "{}"],
])("keeps the local %s %s fixture route", async (method, target, body) => {
  const upstream = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response("unexpected upstream request", { status: 502 }),
    );
  onTestFinished(() => upstream.mockRestore());

  const reply = await registryRequest(target, method);

  expect(upstream).not.toHaveBeenCalled();
  expect(reply.status).toBe(200);
  if (body === "metadata")
    expect(JSON.parse(reply.body) as unknown).toMatchObject({
      name: "rea-agents",
      "dist-tags": { latest: "6.0.0" },
    });
  else expect(reply.body).toBe(body);
});

it("returns upstream failures as plain text and preserves the original failure", async () => {
  const failure = new Error("fixture <script>marker()</script>");
  const upstream = vi.spyOn(globalThis, "fetch").mockRejectedValue(failure);
  onTestFinished(() => upstream.mockRestore());

  const reply = await registryRequest("/unlisted", "GET", failure);

  expect(reply).toMatchObject({
    status: 500,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
    body: String(failure),
  });
});
