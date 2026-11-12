import { describe, expect, it, vi } from "vitest";

import { err, ok, type Result } from "../domain/result.js";
import { safeParseJson } from "../domain/safeJson.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import {
  UpdateCommandRunner,
  type UpdateCommandFailure,
} from "./UpdateCommandRunner.js";
import { systemUpdateHost } from "./UpdateRuntime.js";

const installation = {
  manager: "npm",
  prefix: "/opt/rea",
  packageRoot: "/opt/rea/lib/node_modules/rea-agents",
} as const;

const lookup = async (
  response: Result<string, UpdateCommandFailure>,
  selected: typeof installation | null = installation,
) => {
  const probe = vi
    .spyOn(UpdateCommandRunner.prototype, "runProbe")
    .mockResolvedValue(response);
  const host = systemUpdateHost();
  try {
    const result = await host.latestVersion(selected ?? undefined);
    return { result, command: probe.mock.calls[0]?.[0] };
  } finally {
    await host.close?.();
    probe.mockRestore();
  }
};

describe("npm latest release metadata", () => {
  it.each(['"6.0.0"', '[\n  "6.0.0"\n]\n'])(
    "accepts a scalar or singleton-array response: %j",
    async (metadata) => {
      expect((await lookup(ok(metadata))).result).toEqual(ok("6.0.0"));
    },
  );

  it.each([
    ["empty array", "[]"],
    ["multiple versions", '["6.0.0", "6.0.1"]'],
    ["empty version", '[""]'],
    ["number", "6"],
    ["object", '{"version":"6.0.0"}'],
    ["null", "null"],
  ])("rejects %s response data", async (_description, metadata) => {
    const { result } = await lookup(ok(metadata));
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "invalid-metadata" },
    });
    if (result.ok || result.error.kind !== "invalid-metadata")
      throw new Error("Expected invalid metadata");
    expect(result.error.detail).toMatch(
      /version string.*single-element version array/i,
    );
  });

  it("preserves malformed JSON separately from a wrong metadata shape", async () => {
    const metadata = '"6.0.0';
    const decoded = safeParseJson(metadata);
    if (decoded.ok) throw new Error("Expected malformed JSON");
    expect((await lookup(ok(metadata))).result).toEqual(
      err({ kind: "invalid-metadata", detail: decoded.error }),
    );
  });

  it("keeps command failures distinct from rejected metadata", async () => {
    expect(
      (
        await lookup(
          err({ kind: "execution", detail: "npm registry returned HTTP 503" }),
        )
      ).result,
    ).toEqual(
      err({ kind: "unavailable", detail: "npm registry returned HTTP 503" }),
    );
    expect(
      (await lookup(err({ kind: "launch", detail: "npm missing" }))).result,
    ).toEqual(
      err({
        kind: "package-manager-unavailable",
        manager: "npm",
        detail: "npm missing",
      }),
    );
  });

  it("keeps the global registry query and adds the owning prefix", async () => {
    const selected = await lookup(ok('"6.0.0"'));
    expect(selected.command).toEqual([
      "npm",
      "view",
      "--global",
      "--prefix",
      installation.prefix,
      PRODUCT_IDENTITY.packageName,
      "dist-tags.latest",
      "--json",
      "--fetch-retries=0",
      "--fetch-timeout=10000",
    ]);
    const unspecified = await lookup(ok('"6.0.0"'), null);
    expect(unspecified.command).toEqual([
      "npm",
      "view",
      "--global",
      PRODUCT_IDENTITY.packageName,
      "dist-tags.latest",
      "--json",
      "--fetch-retries=0",
      "--fetch-timeout=10000",
    ]);
  });
});
