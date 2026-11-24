import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { phaseArrival, phaseGate } from "../support/lifecycleHarness.js";

const writers = vi.hoisted(() => ({
  before: undefined as undefined | ((path: string) => Promise<void>),
  after: undefined as undefined | ((path: string) => Promise<void>),
  duringRead: undefined as undefined | (() => Promise<void>),
}));

vi.mock(
  "../../src/application/ClientConfigurationPublication.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../src/application/ClientConfigurationPublication.js")
      >();
    return {
      ...actual,
      ClientConfigurationPublication: {
        write: async (
          ...args: Parameters<
            typeof actual.ClientConfigurationPublication.write
          >
        ) => {
          await writers.before?.(args[0]);
          const publication = await actual.ClientConfigurationPublication.write(
            ...args,
          );
          await writers.after?.(args[0]);
          return publication;
        },
      },
    };
  },
);

vi.mock("../../src/process/BoundedFileBytes.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/process/BoundedFileBytes.js")
    >();
  return {
    ...actual,
    readBoundedFileBytes: async (
      ...args: Parameters<typeof actual.readBoundedFileBytes>
    ) => {
      const bytes = await actual.readBoundedFileBytes(...args);
      const mutation = writers.duringRead;
      writers.duringRead = undefined;
      await mutation?.();
      return bytes;
    },
  };
});

import * as transactions from "../../src/application/ClientConfigurationTransaction.js";
import { configureClientConfiguration } from "../../src/application/SetupClientConfiguration.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { supportedClientRegistrationProfile } from "../fixtures/clientRegistrationProfile.js";

afterEach(() => {
  writers.before = undefined;
  writers.after = undefined;
  writers.duringRead = undefined;
});

it("reports a conflict when a file changes while the freshness snapshot is being read", async () => {
  const root = await createTestTempDirectory("rea-config-read-conflict-");
  const path = join(root, "config.json");
  const changed = '{"external":"changed during read"}\n';
  await writeFile(path, "{}\n");
  writers.before = async (target) => {
    writers.duringRead = () => writeFile(target, changed);
  };

  expect(
    await configureClientConfiguration({
      name: "cursor",
      registrationProfile: supportedClientRegistrationProfile("cursor"),
      configPath: path,
      format: "json",
    }),
  ).toMatchObject({ status: "failed", reason: "conflict" });
  expect(await readFile(path, "utf8")).toBe(changed);
});

it.each(["before", "after"] as const)(
  "preserves an invalid UTF-8 replacement written %s installation and reports a conflict",
  async (phase) => {
    const root = await createTestTempDirectory(
      "rea-config-invalid-replacement-",
    );
    const path = join(root, "config.json");
    const original = "{}\n";
    const changed = Buffer.from([0xff, 0xfe]);
    await writeFile(path, original);
    writers[phase] = (target) => writeFile(target, changed);

    expect(
      await configureClientConfiguration({
        name: "cursor",
        registrationProfile: supportedClientRegistrationProfile("cursor"),
        configPath: path,
        format: "json",
      }),
    ).toMatchObject({ status: "failed", reason: "conflict" });
    expect(Buffer.compare(await readFile(path), changed)).toBe(0);
    expect(await readFile(`${path}.rea.backup`, "utf8")).toBe(original);
    expect((await readdir(root)).sort()).toEqual([
      "config.json",
      "config.json.rea.backup",
    ]);
  },
);

it("preserves an unrelated concurrent edit when a matching recovery backup already exists", async () => {
  const root = await createTestTempDirectory("rea-config-conflict-");
  const path = join(root, "config.json");
  const original = '{"theme":"dark"}\n';
  const changed =
    '{"theme":"light","mcpServers":{"other":{"command":"other"}}}\n';
  await writeFile(path, original);
  await writeFile(`${path}.rea.backup`, original);
  writers.before = (target) => writeFile(target, changed);

  const result = await configureClientConfiguration({
    name: "cursor",
    registrationProfile: supportedClientRegistrationProfile("cursor"),
    configPath: path,
    format: "json",
  });

  expect(result).toMatchObject({ status: "failed", reason: "conflict" });
  expect(await readFile(path, "utf8")).toBe(changed);
  expect(await readFile(`${path}.rea.backup`, "utf8")).toBe(original);
  expect((await readdir(root)).sort()).toEqual([
    "config.json",
    "config.json.rea.backup",
  ]);
  writers.before = undefined;
  const retry = await configureClientConfiguration({
    name: "cursor",
    registrationProfile: supportedClientRegistrationProfile("cursor"),
    configPath: path,
    format: "json",
  });
  expect(retry.status).toBe("configured");
  if (retry.status !== "configured" || retry.backupPath === undefined)
    throw new Error("Retry did not preserve its current recovery snapshot");
  expect(await readFile(retry.backupPath, "utf8")).toBe(changed);
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
    theme: "light",
    mcpServers: { other: { command: "other" } },
  });
  expect(
    await configureClientConfiguration({
      name: "cursor",
      registrationProfile: supportedClientRegistrationProfile("cursor"),
      configPath: path,
      format: "json",
    }),
  ).toEqual({ status: "unchanged" });
});

it("does not recreate a configuration deleted during setup", async () => {
  const root = await createTestTempDirectory("rea-config-deleted-");
  const path = join(root, "config.json");
  await writeFile(path, "{}\n");
  writers.before = (target) => rm(target);

  expect(
    await configureClientConfiguration({
      name: "cursor",
      registrationProfile: supportedClientRegistrationProfile("cursor"),
      configPath: path,
      format: "json",
    }),
  ).toMatchObject({ status: "failed", reason: "conflict" });
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("preserves an external edit made after the atomic write without rolling it back", async () => {
  const root = await createTestTempDirectory("rea-config-after-write-");
  const path = join(root, "config.json");
  const changed = '{"theme":"external"}\n';
  await writeFile(path, "{}\n");
  writers.after = (target) => writeFile(target, changed);

  expect(
    await configureClientConfiguration({
      name: "cursor",
      registrationProfile: supportedClientRegistrationProfile("cursor"),
      configPath: path,
      format: "json",
    }),
  ).toMatchObject({ status: "failed", reason: "conflict" });
  expect(await readFile(path, "utf8")).toBe(changed);
});

it("does not adopt another writer's replacement merely because its bytes match", async () => {
  const root = await createTestTempDirectory("rea-config-replaced-");
  const path = join(root, "config.json");
  const replacement = join(root, "replacement.json");
  let replacementInode: number | undefined;
  writers.after = async (target) => {
    await writeFile(replacement, await readFile(target));
    replacementInode = (await lstat(replacement)).ino;
    await rename(replacement, target);
  };

  expect(
    await configureClientConfiguration({
      name: "cursor",
      registrationProfile: supportedClientRegistrationProfile("cursor"),
      configPath: path,
      format: "json",
    }),
  ).toMatchObject({ status: "failed", reason: "conflict" });
  expect((await lstat(path)).ino).toBe(replacementInode);
});

it("detects a replacement of the original file even when its contents are identical", async () => {
  const root = await createTestTempDirectory("rea-config-original-replaced-");
  const path = join(root, "config.json");
  const replacement = join(root, "replacement.json");
  await writeFile(path, "{}\n");
  let replacementInode: number | undefined;
  writers.before = async (target) => {
    await writeFile(replacement, await readFile(target));
    replacementInode = (await lstat(replacement)).ino;
    await rename(replacement, target);
  };
  expect(
    await configureClientConfiguration({
      name: "cursor",
      registrationProfile: supportedClientRegistrationProfile("cursor"),
      configPath: path,
      format: "json",
    }),
  ).toMatchObject({ status: "failed", reason: "conflict" });
  expect((await lstat(path)).ino).toBe(replacementInode);
  expect(await readFile(path, "utf8")).toBe("{}\n");
});

it.skipIf(process.platform === "win32")(
  "does not follow a retargeted configuration symlink",
  async () => {
    const root = await createTestTempDirectory("rea-config-retargeted-");
    const path = join(root, "config.json");
    const first = join(root, "first.json");
    const second = join(root, "second.json");
    await writeFile(first, "{}\n");
    await writeFile(second, '{"external":true}\n');
    await symlink(first, path);
    writers.before = async () => {
      await rm(path);
      await symlink(second, path);
    };

    expect(
      await configureClientConfiguration({
        name: "cursor",
        registrationProfile: supportedClientRegistrationProfile("cursor"),
        configPath: path,
        format: "json",
      }),
    ).toMatchObject({ status: "failed", reason: "conflict" });
    expect(await readFile(first, "utf8")).toBe("{}\n");
    expect(await readFile(second, "utf8")).toBe('{"external":true}\n');
  },
);

it("merges queued setup requests through absolute and relative paths to the same file", async () => {
  const root = await createTestTempDirectory("rea-config-queued-");
  const path = join(root, "config.json");
  const client = {
    name: "cursor",
    registrationProfile: supportedClientRegistrationProfile("cursor"),
    configPath: path,
    format: "json",
  } as const;
  const callerDirectory = process.cwd();
  process.chdir(root);
  try {
    const results = await Promise.all([
      configureClientConfiguration(client, { FIRST: "1" }),
      configureClientConfiguration(
        { ...client, configPath: "./config.json" },
        { SECOND: "2" },
      ),
    ]);
    expect(results.map(({ status }) => status)).toEqual([
      "configured",
      "configured",
    ]);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      mcpServers: { rea: { env: { FIRST: "1", SECOND: "2" } } },
    });
  } finally {
    process.chdir(callerDirectory);
  }
});

it.skipIf(process.platform === "win32")(
  "serializes setup through a directory symlink and its real directory",
  async () => {
    for (const presence of ["missing", "existing"] as const) {
      const root = await createTestTempDirectory(
        `rea-config-dir-alias-${presence}-`,
      );
      const realDirectory = join(root, "real");
      const alias = join(root, "alias");
      await mkdir(realDirectory);
      await symlink(realDirectory, alias, "dir");
      const realPath = join(realDirectory, "config.json");
      const aliasPath = join(alias, "config.json");
      if (presence === "existing") await writeFile(realPath, "{}\n");

      const entered: string[] = [];
      const queued = phaseArrival<string>();
      const writer = phaseGate();
      writers.before = () => writer.hold();
      const withTransaction = transactions.withClientConfigurationTransaction;
      let requests = 0;
      const observe = vi
        .spyOn(transactions, "withClientConfigurationTransaction")
        .mockImplementation(
          <Value>(path: string, operation: () => Promise<Value>) => {
            const attempt = withTransaction(path, () => {
              entered.push(path);
              return operation();
            });
            // Receipt from the real owner after the queue lookup.
            if (++requests === 2) queued.arrive(path);
            return attempt;
          },
        );

      const first = configureClientConfiguration(
        {
          name: "cursor",
          registrationProfile: supportedClientRegistrationProfile("cursor"),
          configPath: realPath,
          format: "json",
        },
        { FIRST: "1" },
      );
      let second: ReturnType<typeof configureClientConfiguration> | undefined;
      try {
        await writer.reached(first, "setup configuration writer");
        second = configureClientConfiguration(
          {
            name: "cursor",
            registrationProfile: supportedClientRegistrationProfile("cursor"),
            configPath: aliasPath,
            format: "json",
          },
          { SECOND: "2" },
        );
        await expect(
          queued.reached(second, "second configuration transaction"),
        ).resolves.toBe(realPath);
        expect(entered).toEqual([realPath]);
        writer.release();
        const [firstResult, secondResult] = await Promise.all([first, second]);
        expect([firstResult.status, secondResult.status]).toEqual([
          "configured",
          "configured",
        ]);
        expect(JSON.parse(await readFile(realPath, "utf8"))).toMatchObject({
          mcpServers: { rea: { env: { FIRST: "1", SECOND: "2" } } },
        });
        expect(await readFile(aliasPath, "utf8")).toBe(
          await readFile(realPath, "utf8"),
        );
      } finally {
        writer.release();
        writers.before = undefined;
        await Promise.allSettled([first, second]);
        observe.mockRestore();
      }
    }
  },
);

it.skipIf(process.platform === "win32")(
  "preserves a concurrent permission change even when the configuration bytes match",
  async () => {
    const root = await createTestTempDirectory("rea-config-mode-conflict-");
    const path = join(root, "config.json");
    const original = "{}\n";
    await writeFile(path, original, { mode: 0o600 });
    writers.before = (target) => chmod(target, 0o640);

    expect(
      await configureClientConfiguration({
        name: "cursor",
        registrationProfile: supportedClientRegistrationProfile("cursor"),
        configPath: path,
        format: "json",
      }),
    ).toMatchObject({ status: "failed", reason: "conflict" });
    expect(await readFile(path, "utf8")).toBe(original);
    expect((await lstat(path)).mode & 0o777).toBe(0o640);
    expect(await readFile(`${path}.rea.backup`, "utf8")).toBe(original);
  },
);

it("releases a failed setup transaction so a queued request can configure the file", async () => {
  const root = await createTestTempDirectory("rea-config-queued-failure-");
  const path = join(root, "config.json");
  const client = {
    name: "cursor",
    registrationProfile: supportedClientRegistrationProfile("cursor"),
    configPath: path,
    format: "json",
  } as const;
  const writer = phaseGate();
  writers.before = async () => {
    writers.before = undefined;
    await writer.hold();
    throw new Error("The first writer could not stage its configuration");
  };

  const first = configureClientConfiguration(client, { FIRST: "1" });
  let second: ReturnType<typeof configureClientConfiguration> | undefined;
  try {
    await writer.reached(first, "setup configuration writer");
    second = configureClientConfiguration(client, { SECOND: "2" });
    writer.release();
    const [failed, queued] = await Promise.all([first, second]);

    expect(failed).toMatchObject({
      status: "failed",
      reason: "write",
      failure: {
        operation: "publish",
        path,
        detail: "The first writer could not stage its configuration",
      },
    });
    expect(queued.status).toBe("configured");
    expect(JSON.parse(await readFile(path, "utf8")).mcpServers.rea.env).toEqual(
      {
        SECOND: "2",
      },
    );
    expect(await readdir(root)).toEqual(["config.json"]);
    expect(await configureClientConfiguration(client)).toEqual({
      status: "unchanged",
    });
  } finally {
    writer.release();
    writers.before = undefined;
    await Promise.allSettled([first, second]);
  }
});
