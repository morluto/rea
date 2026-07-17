import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildManagedPeFixture } from "../scripts/lib/managed-pe-fixture.mjs";
import { parseBinaryTarget } from "../src/domain/binaryTarget.js";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("managed conformance fixture", () => {
  it("emits PE32+ headers when the COFF machine is x86-64", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rea-managed-fixture-"));
    workspaces.push(workspace);
    const path = join(workspace, "fixture.exe");
    await writeFile(path, buildManagedPeFixture({ machine: 0x8664 }));

    const parsed = await parseBinaryTarget(path);

    expect(parsed).toMatchObject({
      ok: true,
      value: {
        format: "pe",
        architecture: "x86_64",
        managed: true,
      },
    });
  });
});
