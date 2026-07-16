import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const script = join(process.cwd(), "scripts", "check-dependency-install.mjs");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

const fixture = async (
  installedVersion?: string,
  omitDevDependency = false,
) => {
  const root = await mkdtemp(join(tmpdir(), "rea-deps-"));
  roots.push(root);
  await mkdir(join(root, "node_modules"));
  await writeFile(
    join(root, "package-lock.json"),
    JSON.stringify({
      packages: {
        "": {
          dependencies: { alpha: "1.0.0" },
          devDependencies: { beta: "2.0.0" },
        },
        "node_modules/alpha": { version: "1.0.0" },
        "node_modules/beta": { version: "2.0.0" },
      },
    }),
  );
  await writeFile(
    join(root, "node_modules", ".package-lock.json"),
    JSON.stringify({
      packages: {
        "node_modules/alpha": { version: installedVersion ?? "1.0.0" },
        ...(omitDevDependency
          ? {}
          : { "node_modules/beta": { version: "2.0.0" } }),
        "node_modules/unrelated": { version: "9.0.0" },
      },
    }),
  );
  return root;
};

describe("dependency install freshness", () => {
  it("accepts matching direct packages and ignores extraneous packages", async () => {
    const result = spawnSync(process.execPath, [script], {
      cwd: await fixture(),
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("reports a direct version mismatch with one remediation", async () => {
    const result = spawnSync(process.execPath, [script], {
      cwd: await fixture("0.9.0"),
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("alpha: installed 0.9.0, expected 1.0.0");
    expect(result.stderr.match(/npm ci/gu)).toHaveLength(1);
  });

  it("reports a missing direct development dependency", async () => {
    const result = spawnSync(process.execPath, [script], {
      cwd: await fixture(undefined, true),
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "beta: missing from the installed dependency lockfile",
    );
    expect(result.stderr.match(/npm ci/gu)).toHaveLength(1);
  });
});
