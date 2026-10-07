import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, expect, it } from "vitest";

import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
} from "../../fixtures/fakeCdpBrowser.js";

const execute = promisify(execFile);
const browsers: FakeCdpBrowser[] = [];

afterEach(async () => {
  await Promise.all(browsers.splice(0).map(async (browser) => browser.close()));
});

it("reports missing JSON shapes only when body shapes are selected", async () => {
  const browser = await startFakeCdpBrowser({
    malformedRedirectResponse: true,
    redirectResponseEnvelope: null,
  });
  browsers.push(browser);
  const commonArgs = [
    "inspect-web-page",
    browser.endpoint,
    "allowed-page",
    "--allowed-origins",
    browser.allowedOrigin,
    "--observation-ms",
    "0",
  ];
  const selected = normalizedResult(
    await runCli([...commonArgs, "--include-json-body-shapes", "--json"]),
  );
  expect(selected).toMatchObject({
    network: {
      requests: [
        {
          body_shapes: {
            status: "partial",
            request: expect.any(Object),
            response: null,
          },
        },
      ],
    },
    completeness: {
      unavailable_sections: expect.arrayContaining([
        "network_requests",
        "json_body_shapes",
      ]),
      excluded: expect.arrayContaining([
        {
          section: "json_body_shapes",
          reason: "invalid_protocol_value",
          count: expect.any(Number),
        },
      ]),
    },
  });

  const defaulted = normalizedResult(await runCli([...commonArgs, "--json"]));
  expect(defaulted).toMatchObject({
    network: {
      requests: [
        {
          body_shapes: {
            status: "not_approved",
            request: null,
            response: null,
          },
        },
      ],
    },
  });
  expect(defaulted.completeness).toMatchObject({
    unavailable_sections: expect.not.arrayContaining(["json_body_shapes"]),
  });
});

const runCli = async (arguments_: readonly string[]): Promise<unknown> => {
  try {
    const { stdout } = await execute(
      process.execPath,
      ["scripts/rea.mjs", ...arguments_],
      {
        cwd: process.cwd(),
        env: process.env,
        maxBuffer: 16 * 1_024 * 1_024,
      },
    );
    return JSON.parse(stdout);
  } catch (cause: unknown) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "stdout" in cause &&
      typeof cause.stdout === "string"
    )
      return JSON.parse(cause.stdout);
    throw cause;
  }
};

const normalizedResult = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value) || !isRecord(value.normalized_result))
    throw new TypeError("Missing CLI normalized result");
  return value.normalized_result;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
