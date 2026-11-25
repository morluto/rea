import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  admitXpandaVersion,
  inspectXpandaAvailability,
  resolveXpandaConfiguration,
} from "./XpandaConfiguration.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** Create a minimal but structurally valid xpanda checkout. */
const writeXpandaCheckout = async (version = "2.1.0"): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "rea-xpanda-config-"));
  roots.push(root);
  await mkdir(join(root, "src", "mcp"), { recursive: true });
  await mkdir(join(root, "node_modules", "tsx"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "xpanda", version }),
  );
  await writeFile(join(root, "src", "mcp", "server.ts"), "// producer entry\n");
  await writeFile(
    join(root, "node_modules", "tsx", "package.json"),
    JSON.stringify({ name: "tsx", version: "4.7.0" }),
  );
  return root;
};

describe("admitXpandaVersion", () => {
  it("admits 2.x and records the exact version", () => {
    expect(admitXpandaVersion("2.1.0")).toEqual({
      status: "admitted",
      version: "2.1.0",
    });
  });
  it("refuses other majors with the verified version in the reason", () => {
    expect(admitXpandaVersion("3.0.0")).toMatchObject({
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
    const resolved = await resolveXpandaConfiguration({});
    expect(resolved).toMatchObject({
      ok: false,
      error: { code: "not_configured" },
    });
  });

  it("rejects relative paths", async () => {
    const resolved = await resolveXpandaConfiguration({
      REA_XPANDA_ROOT: "xpanda",
    });
    expect(resolved).toMatchObject({
      ok: false,
      error: { code: "not_configured" },
    });
  });

  it("rejects an absent checkout", async () => {
    const resolved = await resolveXpandaConfiguration({
      REA_XPANDA_ROOT: "/rea-absent-xpanda-checkout",
    });
    expect(resolved).toMatchObject({
      ok: false,
      error: { code: "checkout_invalid" },
    });
  });

  it("requires the producer MCP entry and tsx loader", async () => {
    const root = await writeXpandaCheckout();
    await rm(join(root, "src", "mcp", "server.ts"));
    expect(
      await resolveXpandaConfiguration({ REA_XPANDA_ROOT: root }),
    ).toMatchObject({ ok: false, error: { code: "checkout_invalid" } });
    await writeFile(join(root, "src", "mcp", "server.ts"), "// entry\n");
    await rm(join(root, "node_modules", "tsx", "package.json"));
    expect(
      await resolveXpandaConfiguration({ REA_XPANDA_ROOT: root }),
    ).toMatchObject({ ok: false, error: { code: "checkout_invalid" } });
  });

  it("admits a 2.x checkout and resolves through symlinks", async () => {
    const root = await writeXpandaCheckout("2.2.0");
    const linkParent = await mkdtemp(join(tmpdir(), "rea-xpanda-link-"));
    roots.push(linkParent);
    await symlink(root, join(linkParent, "linked"));
    const resolved = await resolveXpandaConfiguration({
      REA_XPANDA_ROOT: join(linkParent, "linked"),
    });
    expect(resolved).toMatchObject({
      ok: true,
      value: { version: "2.2.0" },
    });
    if (!resolved.ok) return;
    expect(resolved.value.root).toBe(root);
    expect(resolved.value.serverEntry).toBe(
      join(root, "src", "mcp", "server.ts"),
    );
  });

  it("refuses checkouts outside the admitted major", async () => {
    const root = await writeXpandaCheckout("3.1.0");
    const resolved = await resolveXpandaConfiguration({
      REA_XPANDA_ROOT: root,
    });
    expect(resolved).toMatchObject({
      ok: false,
      error: { code: "version_unsupported" },
    });
  });
});

describe("inspectXpandaAvailability", () => {
  it("reports the configured version without starting a process", async () => {
    const root = await writeXpandaCheckout();
    expect(await inspectXpandaAvailability({ REA_XPANDA_ROOT: root })).toEqual({
      status: "available",
      reason: null,
      version: "2.1.0",
    });
    expect(await inspectXpandaAvailability({})).toMatchObject({
      status: "unavailable",
      code: "not_configured",
    });
  });
});
