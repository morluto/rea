import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

import {
  admitXpandaVersion,
  inspectHarmonyAbcAvailability,
  inspectXpandaAvailability,
  resolveXpandaConfiguration,
} from "./XpandaConfiguration.js";

/** Create a minimal but structurally valid xpanda checkout. */
const writeXpandaCheckout = async (
  version = "2.1.0",
  layout: "2.x" | "3.x" = "2.x",
): Promise<string> => {
  const root = await createTestTempDirectory("rea-xpanda-config-");
  const entry =
    layout === "3.x"
      ? join(root, "packages", "xpanda-mcp", "src", "server.ts")
      : join(root, "src", "mcp", "server.ts");
  await mkdir(join(entry, ".."), { recursive: true });
  await mkdir(join(root, "node_modules", "tsx"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "xpanda", version }),
  );
  await writeFile(entry, "// producer entry\n");
  await writeFile(
    join(root, "node_modules", "tsx", "package.json"),
    JSON.stringify({ name: "tsx", version: "4.7.0" }),
  );
  return root;
};

describe("admitXpandaVersion", () => {
  it("admits 2.x and 3.x and records the exact version", () => {
    expect(admitXpandaVersion("2.1.0")).toEqual({
      status: "admitted",
      version: "2.1.0",
    });
    expect(admitXpandaVersion("3.6.0")).toEqual({
      status: "admitted",
      version: "3.6.0",
    });
  });
  it("refuses other majors with the verified version in the reason", () => {
    expect(admitXpandaVersion("4.0.0")).toMatchObject({
      status: "unsupported",
    });
    expect(admitXpandaVersion("1.2.3")).toMatchObject({
      status: "unsupported",
    });
  });
  it("reports non-numeric versions as unresolved", () => {
    expect(admitXpandaVersion("beta")).toMatchObject({ status: "unresolved" });
    expect(admitXpandaVersion(undefined)).toMatchObject({
      status: "unresolved",
    });
  });
});

describe("resolveXpandaConfiguration", () => {
  it("requires the configured root variable", async () => {
    const resolved = await resolveXpandaConfiguration(
      {},
      { platform: "linux" },
    );
    expect(resolved).toMatchObject({
      ok: false,
      error: { code: "not_configured" },
    });
  });

  it("rejects relative paths", async () => {
    const resolved = await resolveXpandaConfiguration(
      { REA_XPANDA_ROOT: "xpanda" },
      { platform: "linux" },
    );
    expect(resolved).toMatchObject({
      ok: false,
      error: { code: "not_configured" },
    });
  });

  it("rejects an absent checkout", async () => {
    const resolved = await resolveXpandaConfiguration(
      { REA_XPANDA_ROOT: "/rea-absent-xpanda-checkout" },
      { platform: "linux" },
    );
    expect(resolved).toMatchObject({
      ok: false,
      error: { code: "checkout_invalid" },
    });
  });

  it("requires the producer MCP entry and tsx loader", async () => {
    const root = await writeXpandaCheckout();
    await rm(join(root, "src", "mcp", "server.ts"));
    expect(
      await resolveXpandaConfiguration(
        { REA_XPANDA_ROOT: root },
        { platform: "linux" },
      ),
    ).toMatchObject({ ok: false, error: { code: "checkout_invalid" } });
    await writeFile(join(root, "src", "mcp", "server.ts"), "// entry\n");
    await rm(join(root, "node_modules", "tsx", "package.json"));
    expect(
      await resolveXpandaConfiguration(
        { REA_XPANDA_ROOT: root },
        { platform: "linux" },
      ),
    ).toMatchObject({ ok: false, error: { code: "checkout_invalid" } });
  });

  it.skipIf(process.platform === "win32")(
    "admits a 2.x checkout and resolves through symlinks",
    async () => {
      const root = await writeXpandaCheckout("2.2.0");
      const linkParent = await createTestTempDirectory("rea-xpanda-link-");
      await symlink(root, join(linkParent, "linked"));
      const resolved = await resolveXpandaConfiguration(
        { REA_XPANDA_ROOT: join(linkParent, "linked") },
        { platform: "linux" },
      );
      expect(resolved).toMatchObject({
        ok: true,
        value: { version: "2.2.0" },
      });
      if (!resolved.ok) return;
      expect(resolved.value.root).toBe(root);
      expect(resolved.value.serverEntry).toBe(
        join(root, "src", "mcp", "server.ts"),
      );
    },
  );

  it("admits a 3.x workspace checkout and resolves its MCP package entry", async () => {
    const root = await writeXpandaCheckout("3.6.0", "3.x");
    const resolved = await resolveXpandaConfiguration(
      { REA_XPANDA_ROOT: root },
      { platform: "linux" },
    );
    expect(resolved).toMatchObject({ ok: true, value: { version: "3.6.0" } });
    if (!resolved.ok) return;
    expect(resolved.value.serverEntry).toBe(
      join(root, "packages", "xpanda-mcp", "src", "server.ts"),
    );
  });

  it("refuses a host whose process ownership is unverified", async () => {
    const root = await writeXpandaCheckout("3.6.0", "3.x");
    const resolved = await resolveXpandaConfiguration(
      { REA_XPANDA_ROOT: root },
      { platform: "win32" },
    );
    expect(resolved).toMatchObject({
      ok: false,
      error: { code: "unsupported_host" },
    });
  });

  it("refuses checkouts outside the admitted majors", async () => {
    const root = await writeXpandaCheckout("4.1.0");
    const resolved = await resolveXpandaConfiguration(
      { REA_XPANDA_ROOT: root },
      { platform: "linux" },
    );
    expect(resolved).toMatchObject({
      ok: false,
      error: { code: "version_unsupported" },
    });
  });
});

describe("inspectHarmonyAbcAvailability", () => {
  it("reports the operation surface a 2.x checkout can serve", async () => {
    const root = await writeXpandaCheckout("2.9.0");
    const availability = await inspectHarmonyAbcAvailability(
      { REA_XPANDA_ROOT: root },
      { platform: "linux" },
    );
    expect(availability).toMatchObject({
      status: "available",
      supportedOperations: [
        "inspect_harmony_abc",
        "list_harmony_abc_classes",
        "decompile_harmony_abc_class",
        "decompile_harmony_abc",
        "disassemble_harmony_abc_method",
        "search_harmony_abc_strings",
      ],
    });
  });

  it("reports the complete surface for a 3.x checkout", async () => {
    const root = await writeXpandaCheckout("3.6.0", "3.x");
    const availability = await inspectHarmonyAbcAvailability(
      { REA_XPANDA_ROOT: root },
      { platform: "linux" },
    );
    expect(availability).toMatchObject({ status: "available" });
    if (availability.status !== "available") return;
    expect(availability.supportedOperations).toHaveLength(14);
    expect(availability.supportedOperations).toContain(
      "inspect_harmony_hap_resources",
    );
  });

  it("reports an unusable checkout instead of claiming readiness", async () => {
    expect(
      await inspectHarmonyAbcAvailability(
        { REA_XPANDA_ROOT: "/rea-absent-xpanda-checkout" },
        { platform: "linux" },
      ),
    ).toMatchObject({ status: "unavailable", code: "runtime_unavailable" });
  });
});

describe("inspectXpandaAvailability", () => {
  it("reports the configured version without starting a process", async () => {
    const root = await writeXpandaCheckout();
    expect(
      await inspectXpandaAvailability(
        { REA_XPANDA_ROOT: root },
        { platform: "linux" },
      ),
    ).toEqual({
      status: "available",
      reason: null,
      version: "2.1.0",
    });
    expect(
      await inspectXpandaAvailability({}, { platform: "linux" }),
    ).toMatchObject({
      status: "unavailable",
      code: "not_configured",
    });
  });
});
