import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { historicalHar } from "../../fixtures/historicalHar.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

/** A HAR whose entries copy the fixture entry with each request URL. */
const harWithRequestUrls = (urls: readonly string[]) => {
  const har = historicalHar();
  const [entry] = har.log.entries;
  if (entry === undefined) throw new Error("Expected a fixture HAR entry");
  return {
    log: {
      ...har.log,
      entries: urls.map((url) => ({
        ...entry,
        request: { ...entry.request, url },
      })),
    },
  };
};

const writeHar = async (urls: readonly string[]): Promise<string> => {
  const path = join(
    await createTestTempDirectory("rea-har-request-url-"),
    "capture.har",
  );
  await writeFile(path, JSON.stringify(harWithRequestUrls(urls)));
  return path;
};

// Each URL is exactly what a WHATWG URL serializer emits, as browsers record
// and send it; RFC 3986 alone rejects the unescaped characters.
const BROWSER_SERIALIZED = [
  "https://fonts.googleapis.com/css?family=Roboto:400,700|Open+Sans",
  "https://api.example.test/graphql?variables={%22id%22:1}",
  "https://api.example.test/search?q=`x`^[1]&rate=100%",
  "https://api.example.test/a|b?q=c\\d",
];

cliTest(
  "inspects and builds HARs with RFC 3986 and browser-serialized request URLs",
  async ({ cli }) => {
    for (const url of BROWSER_SERIALIZED)
      expect(new URL(url).href, "fixture must be a WHATWG serialization").toBe(
        url,
      );
    const rewrittenByWhatwg = "https://EXAMPLE.test/a";
    expect(new URL(rewrittenByWhatwg).href).toBe("https://example.test/a");
    const urls = [rewrittenByWhatwg, ...BROWSER_SERIALIZED];
    const har = await writeHar(urls);
    const inspected = await cli.run({
      arguments: ["inspect-web-network-capture", har, "har", "--json"],
    });
    expect(inspected.exitCode, inspected.stdout + inspected.stderr).toBe(0);
    expect(inspected.json).toMatchObject({
      normalized_result: {
        total_records: urls.length,
        records: urls.map((url) => ({
          reported: { request: { url } },
        })),
      },
    });
    const built = await cli.run({
      arguments: ["environment-build", har, "--dry-run", "--json"],
    });
    expect(built.exitCode, built.stdout + built.stderr).toBe(0);
    expect(built.json).toMatchObject({
      status: "planned",
      capture: { records: urls.length, input: "har" },
    });
  },
);

cliTest(
  "rejects a relative HAR request URL at the public capture path coordinate",
  async ({ cli }) => {
    const har = await writeHar(["/a|b"]);
    const result = await cli.run({
      arguments: ["inspect-web-network-capture", har, "har", "--json"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "invalid_request",
      details: {
        issues: [
          {
            path: ["capturePath", "/log/entries/0/request/url"],
            reason: "invalid_format",
          },
        ],
      },
    });
  },
);
