import {
  readFile,
  readdir,
  rename,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { ok } from "../domain/result.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
let resources: ArtifactResourceScope;
beforeEach(() => {
  resources = new ArtifactResourceScope();
});
import { OwnedStagedOutput } from "../filesystem/OwnedStagedOutput.js";
import {
  registerMcpClient,
  registerMcpClients,
} from "./McpClientRegistration.js";
import type { McpRegistrationClient } from "./McpRegistrationCatalog.js";
import { withClientConfigurationTransaction } from "./ClientConfigurationTransaction.js";

const clientFor = (
  path: string,
  format: McpRegistrationClient["format"] = "amp",
  id: McpRegistrationClient["id"] = "amp",
): McpRegistrationClient => ({
  id,
  displayName: id,
  configPath: path,
  format,
  scope: "global",
});
const register = (
  path: string,
  launcher: { command: string; args: readonly string[] },
  signal?: AbortSignal,
) => registerMcpClient(clientFor(path), launcher, signal, resources);
import { ClientConfigurationPublication } from "./ClientConfigurationPublication.js";
import * as regularReads from "./RegularFileRead.js";

const launcher = {
  command: "/fixture/server path",
  args: ["", "a'b", "--mcp"],
};
const settingsFixture = async (original?: string) => {
  const directory = await createTestTempDirectory("rea-amp-writer-");
  const path = join(directory, "settings.json");
  if (original !== undefined) await writeFile(path, original);
  return { directory, path };
};

afterEach(async () => {
  vi.restoreAllMocks();
  await resources.close();
});

describe("Selected argv and client metadata preservation", () => {
  it("preserves every peer and entry metadata while publishing exact argv with a private backup", async () => {
    const document = {
      "amp.mcpServers": {
        rea: {
          command: "old",
          args: ["old"],
          env: { KEEP: "value" },
          enabled: false,
          custom: [1, null],
        },
        other: { url: "http://fixture.invalid", custom: true },
        ["__proto__"]: { metadata: "preserved own key" },
      },
      theme: "dark",
      nested: { value: [false, "preserved"] },
    };
    const original = JSON.stringify(document);
    const { path, directory } = await settingsFixture(original);
    const result = await register(path, launcher);
    expect(result).toEqual(
      ok({ status: "configured", backupPath: `${path}.rea.backup` }),
    );
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      ...document,
      "amp.mcpServers": {
        ...document["amp.mcpServers"],
        rea: { ...document["amp.mcpServers"].rea, ...launcher },
      },
    });
    expect(await readFile(`${path}.rea.backup`, "utf8")).toBe(original);
    expect((await stat(`${path}.rea.backup`)).mode & 0o777).toBe(0o600);
    expect(
      (await readdir(directory)).some((name) =>
        name.startsWith(".rea-config-"),
      ),
    ).toBe(false);
    const beforeRepeat = await stat(path);
    const contents = await readdir(directory);
    expect(await register(path, launcher)).toEqual(ok({ status: "unchanged" }));
    expect(await stat(path)).toMatchObject({
      ino: beforeRepeat.ino,
      mtimeMs: beforeRepeat.mtimeMs,
    });
    expect(await readdir(directory)).toEqual(contents);
  });

  it("creates absent parent directories and replaces scalar entries only when explicitly requested", async () => {
    const fixture = await settingsFixture();
    const path = join(fixture.directory, "new", "settings.json");
    expect(await register(path, launcher)).toEqual(
      ok({ status: "configured" }),
    );
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      "amp.mcpServers": { rea: launcher },
    });
    const scalar = '{"amp.mcpServers":{"rea":false,"other":7}}';
    await writeFile(fixture.path, scalar);
    expect((await register(fixture.path, launcher)).ok).toBe(true);
    expect(
      JSON.parse(await readFile(fixture.path, "utf8"))["amp.mcpServers"],
    ).toEqual({ rea: launcher, other: 7 });
    expect(await readFile(`${fixture.path}.rea.backup`, "utf8")).toBe(scalar);
  });

  it.each([
    "{",
    "null",
    "[]",
    '{"amp.mcpServers":null}',
    '{"amp.mcpServers":[]}',
  ])(
    "refuses malformed settings %s before backups or writes",
    async (original) => {
      const { path, directory } = await settingsFixture(original);
      const result = await register(path, launcher);
      expect(result.ok).toBe(false);
      expect(await readFile(path, "utf8")).toBe(original);
      expect(await readdir(directory)).toEqual(["settings.json"]);
    },
  );

  it("rejects an empty executable before file writes", async () => {
    const { path, directory } = await settingsFixture();
    const result = await register(path, { command: "", args: [] });
    expect(result.ok).toBe(false);
    expect(await readdir(directory)).toEqual([]);
  });

  it("retains a first backup and selects a matching recovery snapshot for later edits", async () => {
    const { path } = await settingsFixture('{"theme":"first"}');
    await register(path, launcher);
    const secondOriginal = await readFile(path, "utf8");
    const result = await register(path, { command: "next", args: [] });
    expect(result.ok && result.value.backupPath).toMatch(/\.recovery$/);
    if (!result.ok || result.value.backupPath === undefined)
      throw new Error("Missing recovery backup");
    expect(await readFile(result.value.backupPath, "utf8")).toBe(
      secondOriginal,
    );
    expect(await readFile(`${path}.rea.backup`, "utf8")).toBe(
      '{"theme":"first"}',
    );
  });
  it("refuses malformed UTF-8 and an occupied backup without replacing source facts", async () => {
    const { path, directory } = await settingsFixture();
    const invalid = Buffer.from([0x7b, 0xff, 0x7d]);
    await writeFile(path, invalid);
    expect((await register(path, launcher)).ok).toBe(false);
    expect((await readFile(path)).equals(invalid)).toBe(true);
    expect(await readdir(directory)).toEqual(["settings.json"]);
    await writeFile(path, "{}");
    await symlink(path, `${path}.rea.backup`);
    expect((await register(path, launcher)).ok).toBe(false);
    expect(await readFile(path, "utf8")).toBe("{}");
  });
});

describe("Registration cancellation and mixed outcomes", () => {
  it("checks cancellation before side effects and after publication settles", async () => {
    const { path, directory } = await settingsFixture();
    const before = new AbortController();
    before.abort("before registration");
    expect(await register(path, launcher, before.signal)).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    expect(await readdir(directory)).toEqual([]);
    const after = new AbortController();
    const write = ClientConfigurationPublication.write;
    vi.spyOn(ClientConfigurationPublication, "write").mockImplementation(
      async (...args) => {
        const publication = await write(...args);
        after.abort("after publication");
        return publication;
      },
    );
    const result = await register(path, launcher, after.signal);
    expect(result.ok ? undefined : result.error).toMatchObject({
      _tag: "AnalysisCancelledError",
      diagnostics: { configured: true },
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      "amp.mcpServers": { rea: launcher },
    });
    expect(await readdir(directory)).toEqual(["settings.json"]);
  });

  it("cancels queued registration after the existing transaction settles", async () => {
    const { path } = await settingsFixture("{}");
    let unblock!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const admitted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = withClientConfigurationTransaction(path, async () => {
      entered();
      await blocked;
    });
    await admitted;
    const controller = new AbortController();
    const queued = register(path, launcher, controller.signal);
    controller.abort("queued cancellation");
    unblock();
    await first;
    expect(await queued).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    expect(await readFile(path, "utf8")).toBe("{}");
  });

  it("keeps successful siblings after ordinary failures and marks work not started after cancellation", async () => {
    const bad = await settingsFixture("null");
    const good = await settingsFixture("{}");
    const clients = [
      clientFor(bad.path),
      clientFor(good.path, "json", "cursor"),
    ];
    const outcomes = await registerMcpClients(
      clients,
      launcher,
      undefined,
      resources,
    );
    expect(outcomes).toMatchObject([
      { status: "completed", result: { ok: false } },
      {
        status: "completed",
        result: { ok: true, value: { status: "configured" } },
      },
    ]);
    const controller = new AbortController();
    controller.abort("before batch");
    const cancelled = await registerMcpClients(
      clients,
      launcher,
      controller.signal,
      resources,
    );
    expect(cancelled).toMatchObject([
      {
        status: "completed",
        result: { ok: false, error: { _tag: "AnalysisCancelledError" } },
      },
      { status: "not_started" },
    ]);
    expect(await readFile(bad.path, "utf8")).toBe("null");
    const late = new AbortController();
    const write = ClientConfigurationPublication.write;
    vi.spyOn(ClientConfigurationPublication, "write").mockImplementation(
      async (...args) => {
        const publication = await write(...args);
        late.abort("published first sibling");
        return publication;
      },
    );
    const partial = await registerMcpClients(
      [clients[1]!, clients[0]!],
      { command: "next", args: [] },
      late.signal,
      resources,
    );
    expect(partial).toMatchObject([
      {
        status: "completed",
        result: {
          ok: false,
          error: {
            _tag: "AnalysisCancelledError",
            diagnostics: { configured: true },
          },
        },
      },
      { status: "not_started" },
    ]);
    expect(
      JSON.parse(await readFile(good.path, "utf8")).mcpServers.rea.command,
    ).toBe("next");
  });
});

describe("Client registration publication recovery", () => {
  it("restores original bytes when owned readback fails", async () => {
    const original = '{"theme":"keep"}';
    const { path, directory } = await settingsFixture(original);
    vi.spyOn(regularReads, "readRegularFileText").mockRejectedValueOnce(
      new Error("fixture readback denied"),
    );
    const result = await register(path, launcher);
    expect(result.ok).toBe(false);
    expect(await readFile(path, "utf8")).toBe(original);
    expect(await readFile(`${path}.rea.backup`, "utf8")).toBe(original);
    expect(
      (await readdir(directory)).some((name) =>
        name.startsWith(".rea-config-"),
      ),
    ).toBe(false);
  });

  it("preserves an external replacement instead of rolling it back", async () => {
    const { path } = await settingsFixture('{"theme":"keep"}');
    const external = '{"theme":"external"}';
    const write = ClientConfigurationPublication.write;
    vi.spyOn(ClientConfigurationPublication, "write").mockImplementation(
      async (...args) => {
        const publication = await write(...args);
        await writeFile(path, external);
        return publication;
      },
    );
    expect((await register(path, launcher)).ok).toBe(false);
    expect(await readFile(path, "utf8")).toBe(external);
  });

  it("retains failed staging cleanup after projection while a later layered sibling settles", async () => {
    const first = await settingsFixture();
    const second = await settingsFixture("{}");
    const lower = join(second.directory, "lower.json");
    await writeFile(
      lower,
      '{"mcp":{"peer":{"type":"local","command":["peer"]}}}',
    );
    const originalClose = OwnedStagedOutput.prototype.close;
    const close = vi
      .spyOn(OwnedStagedOutput.prototype, "close")
      .mockImplementation(async function (this: OwnedStagedOutput) {
        if (this.directory.startsWith(first.directory + sep))
          throw new Error("fixture first staging cleanup denied");
        return originalClose.call(this);
      });
    // Observe forbidden nested admission without leaving a self-waiting test.
    const originalRun = resources.run.bind(resources);
    let activeAdmission = false;
    let nestedAdmissions = 0;
    const admission = vi
      .spyOn(resources, "run")
      .mockImplementation(
        async <Value>(operation: () => Promise<Value>): Promise<Value> => {
          if (activeAdmission) {
            nestedAdmissions++;
            throw new Error(
              "A retained caller scope must not be admitted recursively",
            );
          }
          activeAdmission = true;
          try {
            return await originalRun(operation);
          } finally {
            activeAdmission = false;
          }
        },
      );
    try {
      let projected: readonly string[];
      {
        const clients = [
          clientFor(first.path),
          {
            ...clientFor(second.path, "kilo", "kilo-code"),
            configPaths: [lower, second.path],
          },
        ];
        const outcomes = await resources.run(() =>
          registerMcpClients(clients, launcher, undefined, resources),
        );
        expect(outcomes).toMatchObject([
          {
            status: "completed",
            result: { ok: false, error: { cleanupIncomplete: true } },
          },
          {
            status: "completed",
            result: { ok: true, value: { status: "configured" } },
          },
        ]);
        projected = outcomes.map((outcome) =>
          outcome.status === "not_started"
            ? "not_started"
            : outcome.result.ok
              ? outcome.result.value.status
              : outcome.result.error._tag,
        );
      }
      expect(projected).toEqual(["ConfigurationError", "configured"]);
      expect(nestedAdmissions).toBe(0);
      expect(resources.hasPending).toBe(true);
      await expect(resources.close()).rejects.toBeDefined();
      expect(resources.hasPending).toBe(true);
      close.mockRestore();
      await resources.close();
      expect(resources.hasPending).toBe(false);
      expect(await readdir(first.directory)).toEqual(["settings.json"]);
      expect(
        JSON.parse(await readFile(second.path, "utf8")).mcp.rea.command,
      ).toEqual([launcher.command, ...launcher.args]);
    } finally {
      close.mockRestore();
      admission.mockRestore();
    }
  });

  it("resolves an owned configuration symlink to its selected file", async () => {
    const { path, directory } = await settingsFixture("{}");
    const alias = join(directory, "alias.json");
    await symlink(path, alias);
    const result = await register(alias, launcher);
    expect(result.ok).toBe(true);
    expect(
      JSON.parse(await readFile(path, "utf8"))["amp.mcpServers"].rea,
    ).toEqual(launcher);
    expect(await readFile(alias, "utf8")).toBe(await readFile(path, "utf8"));
  });
});

it("refuses a semantic no-op when the admitted file was replaced with identical bytes", async () => {
  const original = JSON.stringify({ "amp.mcpServers": { rea: launcher } });
  const { path } = await settingsFixture(original);
  const read = regularReads.readRegularFileTextSnapshot;
  let reads = 0;
  let replaced = false;
  vi.spyOn(regularReads, "readRegularFileTextSnapshot").mockImplementation(
    async (...args) => {
      if (++reads === 2) {
        await writeFile(`${path}.replacement`, original);
        await rename(`${path}.replacement`, path);
        replaced = true;
      }
      return read(...args);
    },
  );
  expect(await register(path, launcher)).toMatchObject({ ok: false });
  expect(replaced).toBe(true);
  expect(await readFile(path, "utf8")).toBe(original);
});
