import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { writeFakeXcrun } from "../../fixtures/darwinHelperToolchain.js";
import {
  createDarwinHelperCache,
  darwinHelperCacheDirectory,
  defaultDarwinHelperCacheDirectory,
} from "../../../src/process/DarwinHelperCache.js";
import { createDarwinProcessRunTokenReader } from "../../../src/process/DarwinProcessRunTokenReader.js";
import { createSystemProcessOwnershipHost } from "../../../src/process/ProcessOwnershipObservation.js";

const execFileAsync = promisify(execFile);
const posix = process.platform !== "win32";
const onDarwin = process.platform === "darwin";

const exists = (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** One cache over fixture sources and toolchain, plus a helper to publish. */
const fixtureCache = async (prefix: string, rootParent = "cache") => {
  const directory = await createTestTempDirectory(prefix);
  const source = join(directory, "Reader.swift");
  await writeFile(source, "// helper source v1\n");
  const compiled = join(directory, "compiled-reader");
  await writeFile(compiled, "#!/bin/sh\necho compiled\n");
  await chmod(compiled, 0o755);
  const xcrun = await writeFakeXcrun(directory);
  const root = join(directory, rootParent, "process-helper");
  const create = () =>
    createDarwinHelperCache({
      directory: root,
      sources: [source],
      xcrun: xcrun.executable,
      environment: process.env,
    });
  return { directory, source, compiled, root, xcrun, create };
};

const missKey = async (
  cache: ReturnType<typeof createDarwinHelperCache>,
): Promise<string> => {
  const lookup = await cache.lookup();
  if (lookup.kind !== "miss")
    throw new Error(`Expected a miss: ${lookup.kind}`);
  return lookup.key;
};

it.skipIf(!posix)(
  "publishes a private verified entry that a later process reuses",
  async () => {
    const fixture = await fixtureCache("rea-helper-cache-publish-");
    const first = fixture.create();
    const key = await missKey(first);
    const published = await first.publish(key, fixture.compiled);
    expect(published).toBe(join(await realpath(fixture.root), key, "reader"));
    expect((await stat(fixture.root)).mode & 0o777).toBe(0o700);
    expect((await stat(join(fixture.root, key))).mode & 0o777).toBe(0o700);
    expect((await stat(published ?? "")).mode & 0o777).toBe(0o700);
    expect(
      (await stat(join(fixture.root, key, "manifest.json"))).mode & 0o777,
    ).toBe(0o600);
    expect(await readdir(fixture.root)).toEqual([key]);
    // A fresh cache object stands in for the next REA process.
    expect(await fixture.create().lookup()).toEqual({
      kind: "hit",
      executable: published,
    });
    await first.close();
  },
);

it.skipIf(!posix)(
  "keys entries on helper sources and the toolchain xcrun resolves",
  async () => {
    const fixture = await fixtureCache("rea-helper-cache-key-");
    const keys = [await missKey(fixture.create())];
    await writeFile(fixture.source, "// helper source v2\n");
    keys.push(await missKey(fixture.create()));
    // An in-place compiler or SDK update keeps paths but changes identity.
    await writeFile(fixture.xcrun.swiftc, "compiler v2 (longer)");
    keys.push(await missKey(fixture.create()));
    const later = new Date(Date.now() + 60_000);
    await utimes(join(fixture.xcrun.sdk, "SDKSettings.json"), later, later);
    keys.push(await missKey(fixture.create()));
    expect(new Set(keys).size).toBe(keys.length);
  },
);

it.skipIf(!posix)(
  "never executes or removes an invalid, linked, or loosened entry",
  async () => {
    const fixture = await fixtureCache("rea-helper-cache-invalid-");
    const corruptions: Record<string, (entry: string) => Promise<void>> = {
      "changed helper bytes": (entry) =>
        writeFile(join(entry, "reader"), "#!/bin/sh\necho replaced\n"),
      "manifest for another key": async (entry) => {
        const manifest = JSON.parse(
          await readFile(join(entry, "manifest.json"), "utf8"),
        ) as Record<string, unknown>;
        await writeFile(
          join(entry, "manifest.json"),
          JSON.stringify({ ...manifest, key: "0".repeat(64) }),
        );
      },
      "group-writable entry": (entry) => chmod(entry, 0o770),
      "group-writable helper": (entry) => chmod(join(entry, "reader"), 0o770),
      "malformed manifest": (entry) =>
        writeFile(join(entry, "manifest.json"), "{"),
      "linked helper": async (entry) => {
        const target = join(fixture.directory, "elsewhere");
        await writeFile(target, "#!/bin/sh\necho elsewhere\n");
        await chmod(target, 0o700);
        await rm(join(entry, "reader"));
        await symlink(target, join(entry, "reader"));
      },
      "manifest FIFO": async (entry) => {
        await rm(join(entry, "manifest.json"));
        await execFileAsync("/usr/bin/mkfifo", [join(entry, "manifest.json")]);
      },
    };
    for (const [name, corrupt] of Object.entries(corruptions)) {
      const cache = fixture.create();
      const key = await missKey(cache);
      expect(await cache.publish(key, fixture.compiled), name).toBeDefined();
      await corrupt(join(fixture.root, key));
      // Opening the FIFO must not wait for a writer.
      expect(await fixture.create().lookup(), name).toEqual({
        kind: "unavailable",
      });
      // Removal could race another process that verified this path.
      expect(await exists(join(fixture.root, key)), name).toBe(true);
      await chmod(join(fixture.root, key), 0o700);
      await rm(join(fixture.root, key), { recursive: true, force: true });
    }
  },
);

it.skipIf(!posix)(
  "never trusts a linked entry, an untrusted root, or an ancestor others can write",
  async () => {
    const fixture = await fixtureCache("rea-helper-cache-untrusted-");
    const key = await missKey(fixture.create());
    const valid = join(fixture.directory, "valid-entry");
    await mkdir(valid, { mode: 0o700 });
    await symlink(valid, join(fixture.root, key));
    expect(await fixture.create().lookup()).toEqual({ kind: "unavailable" });
    expect((await lstat(join(fixture.root, key))).isSymbolicLink()).toBe(true);

    const loose = await fixtureCache("rea-helper-cache-loose-root-");
    await mkdir(loose.root, { recursive: true });
    await chmod(loose.root, 0o777);
    const looseCache = loose.create();
    expect(await looseCache.lookup()).toEqual({ kind: "unavailable" });
    expect(await looseCache.publish("a".repeat(64), loose.compiled)).toBe(
      undefined,
    );
    expect(await readdir(loose.root)).toEqual([]);

    // Another user could rename the verified entry out of a shared parent.
    const shared = await fixtureCache(
      "rea-helper-cache-shared-parent-",
      "shared/cache",
    );
    await mkdir(join(shared.directory, "shared"), { recursive: true });
    await chmod(join(shared.directory, "shared"), 0o777);
    expect(await shared.create().lookup()).toEqual({ kind: "unavailable" });

    const blocked = await fixtureCache("rea-helper-cache-blocked-root-");
    await writeFile(join(blocked.directory, "cache"), "not a directory");
    expect(await blocked.create().lookup()).toEqual({ kind: "unavailable" });
  },
);

it.skipIf(!posix)(
  "keeps the first concurrent publication and leaves no staging directory",
  async () => {
    const fixture = await fixtureCache("rea-helper-cache-race-");
    const key = await missKey(fixture.create());
    const caches = Array.from({ length: 4 }, () => fixture.create());
    const results = await Promise.all(
      caches.map((cache) => cache.publish(key, fixture.compiled)),
    );
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toMatch(/\/reader$/u);
    expect(await readdir(fixture.root)).toEqual([key]);
    await Promise.all(caches.map((cache) => cache.close()));
  },
);

it.skipIf(!posix)(
  "returns no shared helper when the compiled output or toolchain is unusable",
  async () => {
    const fixture = await fixtureCache("rea-helper-cache-unusable-");
    const key = await missKey(fixture.create());
    expect(
      await fixture.create().publish(key, join(fixture.directory, "absent")),
    ).toBeUndefined();
    const empty = join(fixture.directory, "empty");
    await writeFile(empty, "");
    expect(await fixture.create().publish(key, empty)).toBeUndefined();
    expect(await readdir(fixture.root)).toEqual([]);
    await rm(fixture.xcrun.swiftc);
    expect(await fixture.create().lookup()).toEqual({ kind: "unavailable" });
  },
);

it("shares a helper only for the default toolchain and an absolute home", () => {
  const select = (
    overrides: Partial<Parameters<typeof darwinHelperCacheDirectory>[0]>,
  ) =>
    darwinHelperCacheDirectory({
      home: "/Users/analyst",
      compilerSelected: false,
      moduleCachePath: undefined,
      ...overrides,
    });
  expect(select({})).toBe("/Users/analyst/Library/Caches/rea/process-helper");
  // An empty module cache setting keeps the default, as documented.
  expect(select({ moduleCachePath: "" })).toBe(
    "/Users/analyst/Library/Caches/rea/process-helper",
  );
  expect(select({ moduleCachePath: "/boundary/modules" })).toBeUndefined();
  expect(select({ compilerSelected: true })).toBeUndefined();
  expect(select({ home: "relative/home" })).toBeUndefined();
  expect(select({ home: undefined })).toBeUndefined();
});

it("keeps the caller's home path segments instead of normalizing them", () => {
  // A symlink followed by `..` must resolve on the filesystem, not lexically.
  expect(defaultDarwinHelperCacheDirectory("/Users/analyst/link/../home")).toBe(
    "/Users/analyst/link/../home/Library/Caches/rea/process-helper",
  );
});

it.skipIf(!posix)(
  "stops stalled toolchain lookups when preparation is cancelled",
  async () => {
    const directory = await createTestTempDirectory("rea-helper-cache-stall-");
    const source = join(directory, "Reader.swift");
    await writeFile(source, "// helper source\n");
    const xcrun = await writeFakeXcrun(directory, false, true);
    const cache = createDarwinHelperCache({
      directory: join(directory, "process-helper"),
      sources: [source],
      xcrun: xcrun.executable,
      environment: process.env,
    });
    const started = Date.now();
    expect(await cache.lookup(AbortSignal.timeout(200))).toEqual({
      kind: "unavailable",
    });
    // Far below the 15 s lookup deadline: both lookups ended with the signal.
    expect(Date.now() - started).toBeLessThan(5_000);

    const reader = createDarwinProcessRunTokenReader({
      compiler: { kind: "xcrun", executable: xcrun.executable },
      helperCacheDirectory: join(directory, "reader-cache"),
    });
    const controller = new AbortController();
    const prepared = reader.prepare(controller.signal);
    setTimeout(() => controller.abort(new Error("caller cancelled")), 200);
    const cancelled = Date.now();
    await expect(prepared).rejects.toThrow("caller cancelled");
    await reader.close();
    expect(Date.now() - cancelled).toBeLessThan(5_000);
    expect(await xcrun.compilations()).toBe(0);
  },
);

const fixtureProcess = {
  pid: 123,
  parentPid: 1,
  processGroupId: 123,
  state: "S",
  command: "fixture",
};

it.skipIf(!posix)(
  "runs the shared helper in later readers without recompiling and keeps it after close",
  async () => {
    const directory = await createTestTempDirectory("rea-helper-cache-reader-");
    const helperCacheDirectory = join(directory, "process-helper");
    const xcrun = await writeFakeXcrun(directory);
    const create = () =>
      createDarwinProcessRunTokenReader({
        compiler: { kind: "xcrun", executable: xcrun.executable },
        helperCacheDirectory,
      });
    const first = create();
    let shared: string;
    try {
      shared = await first.prepare();
      expect(shared.endsWith("/reader")).toBe(true);
      expect(shared.includes("/process-helper/")).toBe(true);
      expect((await first.read([fixtureProcess])).get(123)).toEqual({
        state: "readable",
        runId: "fixture",
      });
    } finally {
      await first.close();
    }
    const [compileRoot] = await xcrun.roots();
    expect(compileRoot).toBeDefined();
    expect(await exists(compileRoot ?? "")).toBe(false);
    expect(await exists(shared)).toBe(true);

    const second = create();
    try {
      expect(await second.prepare()).toBe(shared);
      expect((await second.read([fixtureProcess])).get(123)).toEqual({
        state: "readable",
        runId: "fixture",
      });
    } finally {
      await second.close();
    }
    expect(await xcrun.compilations()).toBe(1);
    expect(await exists(shared)).toBe(true);
  },
);

it.skipIf(!posix)(
  "falls back to its own helper when a verified shared copy cannot launch",
  async () => {
    const directory = await createTestTempDirectory("rea-helper-cache-noexec-");
    const helperCacheDirectory = join(directory, "process-helper");
    const xcrun = await writeFakeXcrun(directory);
    const create = () =>
      createDarwinProcessRunTokenReader({
        compiler: { kind: "xcrun", executable: xcrun.executable },
        helperCacheDirectory,
      });
    const first = create();
    let shared: string;
    try {
      shared = await first.prepare();
    } finally {
      await first.close();
    }
    // A consistent entry the kernel refuses to run, as on a noexec volume.
    const unrunnable = Buffer.from("not a program\n");
    await writeFile(shared, unrunnable);
    const manifestPath = join(shared, "..", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      sha256: string;
      size: number;
    };
    const { createHash } = await import("node:crypto");
    await writeFile(
      manifestPath,
      JSON.stringify({
        ...manifest,
        sha256: createHash("sha256").update(unrunnable).digest("hex"),
        size: unrunnable.byteLength,
      }),
    );
    const second = create();
    try {
      expect(await second.prepare()).toBe(shared);
      // Concurrent reads that both launched the shared copy both fall back.
      const reads = await Promise.all([
        second.read([fixtureProcess]),
        second.read([fixtureProcess]),
      ]);
      for (const read of reads)
        expect(read.get(123)).toEqual({ state: "readable", runId: "fixture" });
    } finally {
      await second.close();
    }
    expect(await xcrun.compilations()).toBe(2);
    expect((await readFile(shared)).equals(unrunnable)).toBe(true);
  },
);

it.skipIf(!posix)(
  "publishes nothing when helper compilation is cancelled",
  async () => {
    const directory = await createTestTempDirectory("rea-helper-cache-cancel-");
    const helperCacheDirectory = join(directory, "process-helper");
    const xcrun = await writeFakeXcrun(directory, true);
    const reader = createDarwinProcessRunTokenReader({
      compiler: { kind: "xcrun", executable: xcrun.executable },
      helperCacheDirectory,
    });
    const controller = new AbortController();
    try {
      const prepared = reader.prepare(controller.signal);
      const deadline = Date.now() + 10_000;
      while ((await xcrun.compilations()) === 0 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort(new Error("caller cancelled"));
      await expect(prepared).rejects.toThrow("caller cancelled");
    } finally {
      await reader.close();
    }
    expect(await readdir(helperCacheDirectory)).toEqual([]);
    const [compileRoot] = await xcrun.roots();
    expect(await exists(compileRoot ?? "")).toBe(false);
  },
);

it.skipIf(!onDarwin)(
  "reuses the real default-toolchain helper in a later host without compiling",
  async () => {
    const home = await createTestTempDirectory("rea-helper-cache-home-");
    const cacheRoot = join(home, "Library/Caches/rea/process-helper");
    const environment: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete environment.REA_DARWIN_SWIFTC_PATH;
    delete environment.REA_DARWIN_MODULE_CACHE_PATH;
    const prepare = async (selected: NodeJS.ProcessEnv) => {
      const host = createSystemProcessOwnershipHost("darwin", selected);
      try {
        await host.prepare?.(AbortSignal.timeout(180_000));
        const current = (await host.listProcesses()).find(
          ({ pid }) => pid === process.pid,
        );
        if (current === undefined || host.processIdentities === undefined)
          throw new Error("Darwin host omitted the current process identity");
        expect(
          (await host.processIdentities([current])).get(process.pid),
        ).toMatchObject({ state: "readable" });
      } finally {
        await host.close?.();
      }
    };
    await prepare(environment);
    const [key, ...others] = await readdir(cacheRoot);
    expect(others).toEqual([]);
    const helper = join(cacheRoot, key ?? "", "reader");
    const published = await stat(helper);
    // A compile would need a per-run root under TMPDIR; deny it.
    const noTemporary = join(home, "no-temporary");
    await mkdir(noTemporary, { mode: 0o500 });
    vi.stubEnv("TMPDIR", noTemporary);
    try {
      await prepare(environment);
    } finally {
      vi.unstubAllEnvs();
    }
    expect((await stat(helper)).ino).toBe(published.ino);
    expect(await readdir(cacheRoot)).toEqual([key]);
    expect(await readdir(noTemporary)).toEqual([]);
  },
);
