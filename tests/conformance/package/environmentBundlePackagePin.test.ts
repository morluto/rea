import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  planEnvironmentBundle,
  registryPackageSource,
} from "../../../src/application/environment/environmentBundle.js";
import {
  environmentServeFixture,
  environmentServeServed,
} from "../../fixtures/environmentServe.js";
import { PRODUCT_IDENTITY } from "../../../src/identity.js";
import { supportsNodeVersion } from "../../../src/domain/runtimeVersion.js";

const plannedDockerfile = (): string => {
  const { source, served } = environmentServeServed(environmentServeFixture());
  const planned = planEnvironmentBundle(source, {
    packageSource: registryPackageSource(),
    served: () => served,
  });
  if (!planned.ok) throw planned.error;
  const dockerfile = planned.value.files.find(({ path }) =>
    path.endsWith("/Dockerfile"),
  );
  if (dockerfile === undefined)
    throw new Error("Expected a planned Dockerfile");
  return dockerfile.content;
};

/**
 * The exported Dockerfile installs the CLI that produced the bundle, so the
 * pin must be the exact package version of this build, read from the package
 * manifest rather than restated anywhere in source.
 */
describe("environment bundle package pin", () => {
  it("exports the pinned supported Node runtime in the Dockerfile", async () => {
    const pinned = (
      await readFile(new URL("../../../.nvmrc", import.meta.url), "utf8")
    ).trim();
    const dockerfile = plannedDockerfile();
    const nodeVersion = /^FROM node:(\d+\.\d+\.\d+)(?:[-@][^\s]+)?$/u.exec(
      dockerfile.split("\n")[0] ?? "",
    )?.[1];
    expect(nodeVersion).toBe(pinned);
    expect(supportsNodeVersion(nodeVersion ?? "")).toBe(true);
  });

  it("pins the registry install to the package.json version", async () => {
    const manifest = z
      .object({ name: z.literal("rea-agents"), version: z.string().min(1) })
      .parse(
        JSON.parse(
          await readFile(
            new URL("../../../package.json", import.meta.url),
            "utf8",
          ),
        ),
      );
    const dockerfile = plannedDockerfile();
    const install = dockerfile
      .split("\n")
      .find((line) => line.startsWith("RUN npm install -g"));
    expect(install).toBeDefined();
    expect(install?.endsWith(` ${manifest.name}@${manifest.version}`)).toBe(
      true,
    );
    expect(PRODUCT_IDENTITY.packageVersion).toBe(manifest.version);
    expect(dockerfile).not.toMatch(/rea-agents@(?:latest|\^|~)/u);
  });
});
