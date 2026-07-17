import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveClientConfigTransactionPath } from "../src/application/ClientConfigPath.js";
import { configureJsonClient } from "../src/application/Setup.js";

let directory: string | undefined;
afterEach(async () => {
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("JSON client configuration transaction", () => {
  it("rejects a symlink target not owned by the current user", async () => {
    if (typeof process.getuid !== "function") return;
    const currentUid = process.getuid();
    let statCalls = 0;
    expect(
      await resolveClientConfigTransactionPath("/config", {
        lstat: () => {
          statCalls += 1;
          return Promise.resolve({
            uid: statCalls === 1 ? currentUid : currentUid + 1,
            isFile: () => statCalls > 1,
            isSymbolicLink: () => statCalls === 1,
          });
        },
        realpath: () => Promise.resolve("/target"),
      }),
    ).toBeUndefined();
  });

  it("preserves existing keys, creates a backup, and reads back the MCP entry", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-setup-"));
    const configPath = join(directory, "mcp.json");
    const original =
      '{"theme":"dark","mcpServers":{"other":{"command":"other"}}}\n';
    await writeFile(configPath, original);
    const result = await configureJsonClient({ name: "cursor", configPath });
    expect(result.status).toBe("configured");
    expect(await readFile(`${configPath}.rea.backup`, "utf8")).toBe(original);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      theme: "dark",
      mcpServers: {
        other: { command: "other" },
        rea: {
          command: "npx",
          args: ["-y", "rea-agents@latest", "mcp"],
        },
      },
    });
  });

  it("updates a symlink target without replacing the JSON config symlink", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-setup-"));
    const targetPath = join(directory, "managed.json");
    const configPath = join(directory, "mcp.json");
    const original = '{"theme":"dark"}\n';
    await writeFile(targetPath, original);
    await symlink(targetPath, configPath);

    expect(
      await configureJsonClient({ name: "cursor", configPath }),
    ).toMatchObject({ status: "configured" });
    expect((await lstat(configPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(`${configPath}.rea.backup`, "utf8")).toBe(original);
    expect(JSON.parse(await readFile(targetPath, "utf8"))).toMatchObject({
      theme: "dark",
      mcpServers: {
        rea: {
          command: "npx",
          args: ["-y", "rea-agents@latest", "mcp"],
        },
      },
    });
    expect(await configureJsonClient({ name: "cursor", configPath })).toEqual({
      status: "unchanged",
    });
  });

  it("fails before mutation when a JSON config symlink is dangling", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-setup-"));
    const configPath = join(directory, "mcp.json");
    await symlink(join(directory, "missing.json"), configPath);

    expect(await configureJsonClient({ name: "cursor", configPath })).toEqual({
      status: "failed",
      reason: "path",
    });
    expect((await lstat(configPath)).isSymbolicLink()).toBe(true);
    await expect(
      readFile(`${configPath}.rea.backup`, "utf8"),
    ).rejects.toThrow();
  });

  it("performs no write or second backup when configuration already matches", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-setup-"));
    const configPath = join(directory, "mcp.json");
    await writeFile(
      configPath,
      '{"mcpServers":{"rea":{"command":"npx","args":["-y","rea-agents@latest","mcp"]}}}\n',
    );
    expect(await configureJsonClient({ name: "cursor", configPath })).toEqual({
      status: "unchanged",
    });
    await expect(
      readFile(`${configPath}.rea.backup`, "utf8"),
    ).rejects.toThrow();
  });

  it("migrates an unversioned npx registration and preserves sibling configuration", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-setup-"));
    const configPath = join(directory, "mcp.json");
    const original =
      '{"theme":"dark","mcpServers":{"rea":{"command":"npx","args":["-y","rea-agents","mcp"]},"other":{"command":"other"}}}\n';
    await writeFile(configPath, original);

    expect(await configureJsonClient({ name: "cursor", configPath })).toEqual(
      expect.objectContaining({ status: "configured" }),
    );

    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      theme: "dark",
      mcpServers: {
        rea: {
          command: "npx",
          args: ["-y", "rea-agents@latest", "mcp"],
        },
        other: { command: "other" },
      },
    });
    expect(await readFile(`${configPath}.rea.backup`, "utf8")).toBe(original);
  });

  it("persists a custom Hopper launcher and remains idempotent", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-setup-"));
    const configPath = join(directory, "mcp.json");
    const hopperPath = "/Applications/Hopper v6.app/Contents/MacOS/hopper";
    const client = { name: "cursor", configPath };
    const original = "{}\n";
    await writeFile(configPath, original);
    expect(await configureJsonClient(client, hopperPath)).toMatchObject({
      status: "configured",
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      mcpServers: {
        rea: {
          command: "npx",
          args: ["-y", "rea-agents@latest", "mcp"],
          env: { HOPPER_LAUNCHER_PATH: hopperPath },
        },
      },
    });
    expect(await configureJsonClient(client, hopperPath)).toEqual({
      status: "unchanged",
    });
    expect(
      await configureJsonClient(client, "/opt/hopper/bin/Hopper"),
    ).toMatchObject({ status: "configured" });
    expect(await readFile(`${configPath}.rea.backup`, "utf8")).toBe(original);
  });

  it("adds exact BYO Ghidra and Java paths without installing dependencies", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-setup-"));
    const configPath = join(directory, "mcp.json");
    const client = { name: "cursor", configPath };
    const environment = {
      GHIDRA_INSTALL_DIR: "/opt/ghidra_12.1.2_PUBLIC",
      JAVA_HOME: "/usr/lib/jvm/jdk-21",
    };

    expect(await configureJsonClient(client, environment)).toMatchObject({
      status: "configured",
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      mcpServers: {
        rea: {
          env: {
            GHIDRA_INSTALL_DIR: environment.GHIDRA_INSTALL_DIR,
            JAVA_HOME: environment.JAVA_HOME,
          },
        },
      },
    });
    expect(await configureJsonClient(client, environment)).toEqual({
      status: "unchanged",
    });
  });

  it("refuses malformed existing JSON without overwriting it", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-setup-"));
    const configPath = join(directory, "mcp.json");
    await writeFile(configPath, "not-json");
    expect(await configureJsonClient({ name: "cursor", configPath })).toEqual({
      status: "failed",
      reason: "readback",
    });
    expect(await readFile(configPath, "utf8")).toBe("not-json");
  });

  it.each(["null", "[]", '"value"'])(
    "refuses a non-object JSON root without overwriting %s",
    async (original) => {
      directory = await mkdtemp(join(tmpdir(), "rea-setup-"));
      const configPath = join(directory, "mcp.json");
      await writeFile(configPath, original);
      expect(await configureJsonClient({ name: "cursor", configPath })).toEqual(
        { status: "failed", reason: "readback" },
      );
      expect(await readFile(configPath, "utf8")).toBe(original);
      await expect(
        readFile(`${configPath}.rea.backup`, "utf8"),
      ).rejects.toThrow();
    },
  );

  it.each(["null", "[]", '"value"'])(
    "preserves a non-object mcpServers value %s",
    async (servers) => {
      directory = await mkdtemp(join(tmpdir(), "rea-setup-"));
      const configPath = join(directory, "mcp.json");
      const original = `{"mcpServers":${servers}}`;
      await writeFile(configPath, original);
      expect(await configureJsonClient({ name: "cursor", configPath })).toEqual(
        { status: "failed", reason: "readback" },
      );
      expect(await readFile(configPath, "utf8")).toBe(original);
      await expect(
        readFile(`${configPath}.rea.backup`, "utf8"),
      ).rejects.toThrow();
    },
  );
});
