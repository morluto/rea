import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect } from "vitest";

import { PRODUCT_IDENTITY } from "../../../src/identity.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../support/workspace/workspaceFixture.js";

const cacheFile = (root: string) =>
  `${root}/incur/updates/${encodeURIComponent(PRODUCT_IDENTITY.packageName)}.json`;

cliTest(
  "the detached update check takes precedence over installation and records the latest version",
  async ({ cli }) => {
    const workspace = await createTestWorkspace("rea-update-check-");
    const requests: string[] = [];
    const registry = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ "dist-tags": { latest: "999.1.0" } }));
    });
    registry.listen(0, "127.0.0.1");
    await once(registry, "listening");
    try {
      const { port } = registry.address() as AddressInfo;
      const result = await cli.run({
        arguments: ["--incur-update-check", "--update"],
        freshProcess: true,
        environment: {
          ...workspace.environment,
          XDG_CACHE_HOME: workspace.path("cache"),
          npm_config_cache: workspace.path("npm-cache"),
          npm_config_prefix: workspace.path("npm-prefix"),
          npm_config_registry: `http://127.0.0.1:${port}/`,
        },
      });
      expect(result).toMatchObject({ exitCode: 0, stdout: "", stderr: "" });
      expect(requests).toEqual([
        `/${encodeURIComponent(PRODUCT_IDENTITY.packageName)}`,
      ]);
      const cache = JSON.parse(
        await readFile(cacheFile(workspace.path("cache")), "utf8"),
      ) as { readonly checkedAt: unknown; readonly latest: unknown };
      expect(cache).toEqual({
        checkedAt: expect.any(Number),
        latest: "999.1.0",
      });
    } finally {
      registry.close();
      await removeTestWorkspace(workspace.root);
    }
  },
);

cliTest(
  "an unreachable registry leaves the update cache unwritten and the check silent",
  async ({ cli }) => {
    const workspace = await createTestWorkspace("rea-update-check-");
    try {
      const result = await cli.run({
        arguments: ["--incur-update-check"],
        freshProcess: true,
        environment: {
          ...workspace.environment,
          XDG_CACHE_HOME: workspace.path("cache"),
          npm_config_registry: "http://127.0.0.1:9/",
        },
      });
      expect(result).toMatchObject({ exitCode: 0, stdout: "", stderr: "" });
      await expect(
        readFile(cacheFile(workspace.path("cache")), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await removeTestWorkspace(workspace.root);
    }
  },
);
