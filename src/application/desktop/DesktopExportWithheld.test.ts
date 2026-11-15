import {
  access,
  mkdir,
  readdir,
  readFile,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import {
  ArtifactResourceScope,
  type ArtifactCleanupAttempt,
} from "../../artifacts/ArtifactResourceScope.js";
import type { DesktopApplicationCapture } from "../../domain/desktop/desktopCapture.js";
import type { Evidence } from "../../domain/evidence.js";
import { OwnedFileHandle } from "../../filesystem/OwnedFileHandle.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { exportDesktopApplication } from "./DesktopApplicationExport.js";
import { draftDesktopApplicationTask } from "./DesktopTaskDraft.js";
import {
  HOME,
  capture,
  change,
  checkpoint,
  readers,
  retained,
  writeCaptureFolder,
} from "./desktopCapture.fixture.js";

const SETTINGS = ".config/notes/settings.ini";
const VARIABLE = "REA_NOTES_CONFIG_NOTES_SETTINGS_INI";
const CONSENT = {
  consents: [
    {
      kind: "seed_sign_in",
      subject: "the notes app's settings",
      words: "Yes, seed my settings in this bundle.",
      recorded_at: "2026-11-07T00:00:00.000Z",
      source: "relayed",
    },
  ],
};

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** Export the notes capture, or `recorded` with its extra content, with `options`, into a fresh folder beside a folder for the withheld copies. */
const exportWithheld = async (
  options: Record<string, unknown>,
  tasks: readonly unknown[] = [],
  recorded?: {
    readonly capture: DesktopApplicationCapture;
    readonly content: readonly string[];
  },
  stateReaders = readers,
) => {
  const root = await createTestTempDirectory("desktop-withheld-");
  const directory = join(root, "bundle");
  const withheldCopy = join(root, "withheld");
  const taskPaths = await Promise.all(
    tasks.map(async (task, index) => {
      const path = join(root, `task-${String(index)}.json`);
      await writeFile(path, JSON.stringify(task));
      return path;
    }),
  );
  const result = await exportDesktopApplication(
    {
      capture:
        recorded === undefined
          ? await writeCaptureFolder(capture())
          : await writeCaptureFolder(
              recorded.capture,
              undefined,
              recorded.content,
            ),
      directory,
      name: undefined,
      tasks: taskPaths,
      withheldCopy,
      ...options,
    },
    stateReaders,
  );
  return { result, directory, withheldCopy, root };
};

afterEach(() => {
  vi.restoreAllMocks();
});

/** The notes capture with its settings file at the baseline replaced by `text`. */
const withSettings = (text: string): DesktopApplicationCapture => {
  const base = capture();
  const [first, ...rest] = base.state.checkpoints;
  if (first === undefined) throw new Error("fixture");
  return {
    ...base,
    state: {
      ...base.state,
      checkpoints: [
        {
          ...first,
          retained: first.retained.map((file) =>
            file.path === `${HOME}/${SETTINGS}`
              ? retained(file.path, text)
              : file,
          ),
        },
        ...rest,
      ],
    },
  };
};

/** The notes capture with Documents owned and, at the baseline, a made-up database and a backup of it holding `backup`. */
const withBackup = (
  database: string,
  backup: string,
): DesktopApplicationCapture => {
  const base = capture();
  const [first, ...rest] = base.state.checkpoints;
  if (first === undefined) throw new Error("fixture");
  const documents = `${HOME}/Documents`;
  return {
    ...base,
    application: {
      ...base.application,
      state_directories: [
        ...base.application.state_directories,
        { path: documents, exists_at_start: true },
      ],
    },
    state: {
      ...base.state,
      content_roots: [...base.state.content_roots, documents],
      state_directories: [...(base.state.state_directories ?? []), documents],
      checkpoints: [
        {
          ...first,
          retained: [
            ...first.retained,
            retained(`${documents}/e-test.kdbx`, database),
            retained(`${documents}/e-test.kdbx.bak`, backup),
          ],
        },
        ...rest,
      ],
    },
  };
};

const evidence = (result: Evidence | Error): Evidence => {
  if (result instanceof Error) throw result;
  return result;
};

it("refuses an occupied withheld copy destination before writing the bundle", async () => {
  const root = await createTestTempDirectory("desktop-copy-refusal-");
  const occupied = join(root, "occupied");
  await mkdir(occupied);
  await writeFile(join(occupied, "keep"), "existing");
  const { result, directory } = await exportWithheld({
    withhold: { paths: [SETTINGS] },
    withheldCopy: occupied,
  });
  expect(result).toBeInstanceOf(AnalysisError);
  expect(await exists(directory)).toBe(false);
  expect(await readFile(join(occupied, "keep"), "utf8")).toBe("existing");
  const occupiedFile = join(root, "file");
  await writeFile(occupiedFile, "existing file");
  const file = await exportWithheld({
    withhold: { paths: [SETTINGS] },
    withheldCopy: occupiedFile,
  });
  expect(file.result).toBeInstanceOf(AnalysisError);
  expect(await exists(file.directory)).toBe(false);
  expect(await readFile(occupiedFile, "utf8")).toBe("existing file");
});

it("retains the bundle cleanup owner when a later withheld copy fails", async () => {
  const root = await createTestTempDirectory("desktop-copy-close-");
  const occupied = join(root, "occupied");
  await mkdir(occupied);
  const commit = SafeOutputTree.prototype.commit;
  vi.spyOn(SafeOutputTree.prototype, "commit").mockImplementationOnce(
    async function (this: SafeOutputTree, signal) {
      await commit.call(this, signal);
      await writeFile(join(occupied, "keep"), "existing");
    },
  );
  const original = SafeOutputTree.prototype.closeHandles;
  const release = ArtifactResourceScope.prototype.release;
  const failures: Extract<ArtifactCleanupAttempt, { kind: "failed" }>[] = [];
  vi.spyOn(ArtifactResourceScope.prototype, "release").mockImplementation(
    async function (this: ArtifactResourceScope, owner) {
      const outcome = await release.call(this, owner);
      if (outcome.kind === "failed") failures.push(outcome);
      return outcome;
    },
  );
  vi.spyOn(SafeOutputTree.prototype, "closeHandles")
    .mockImplementationOnce(async () => {
      throw new Error("bundle close failed");
    })
    .mockImplementation(original);
  const { result, directory } = await exportWithheld({
    withhold: { paths: [SETTINGS] },
    withheldCopy: occupied,
  });
  expect(result).toBeInstanceOf(AnalysisError);
  if (!(result instanceof AnalysisError)) throw new Error("expected failure");
  expect(result.cleanupIncomplete).toBe(true);
  expect(result.cleanupResources).toEqual(expect.arrayContaining([directory]));
  expect(projectAnalysisError(result)).toMatchObject({
    details: { partial_observation: { normalized_result: { directory } } },
  });
  expect(result.partialObservation).toMatchObject({
    normalized_result: { directory },
  });
  expect(result.cleanupPrimary).toBeInstanceOf(Error);
  expect(result.secondaryFailures).toEqual([
    expect.objectContaining({ cleanupIncomplete: true }),
  ]);
  expect(failures.length).toBeGreaterThan(0);
  const bundle = failures.find(({ owner }) => owner.resource === directory);
  const copy = failures.find(({ owner }) => owner.resource === occupied);
  expect(bundle).toBeDefined();
  expect(copy).toBeDefined();
  await bundle?.lease.release();
  expect(result.cleanupIncomplete).toBe(true);
  await expect(copy?.lease.release()).rejects.toThrow();
  expect(await readFile(join(occupied, "keep"), "utf8")).toBe("existing");
  await unlink(join(occupied, "keep"));
  await copy?.lease.release();
  expect(result.cleanupIncomplete).toBe(false);
  expect(projectAnalysisError(result)).toMatchObject({
    details: { partial_observation: { normalized_result: { directory } } },
  });
  expect(result.partialObservation).toMatchObject({
    normalized_result: { directory },
  });
});

it.skipIf(process.platform === "win32")(
  "keeps published bundle close failure primary when the withheld copy is cancelled before acquisition",
  async () => {
    const root = await createTestTempDirectory("desktop-copy-cancel-");
    const directory = join(root, "bundle");
    const withheldCopy = join(root, "withheld");
    const controller = new AbortController();
    const reason = new Error("cancel after bundle publication");
    const closeFailure = new Error("bundle descriptor cannot close");
    let isPublished = () => false;
    const failures: Extract<ArtifactCleanupAttempt, { kind: "failed" }>[] = [];
    const commit = SafeOutputTree.prototype.commit;
    vi.spyOn(SafeOutputTree.prototype, "commit").mockImplementation(
      async function (this: SafeOutputTree, ...args) {
        isPublished = () => this.published;
        return commit.apply(this, args);
      },
    );
    const close = OwnedFileHandle.prototype.close;
    const closing = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementation(async function (this: OwnedFileHandle) {
        if (!isPublished()) return close.call(this);
        controller.abort(reason);
        throw closeFailure;
      });
    const release = ArtifactResourceScope.prototype.release;
    vi.spyOn(ArtifactResourceScope.prototype, "release").mockImplementation(
      async function (this: ArtifactResourceScope, owner) {
        const result = await release.call(this, owner);
        if (result.kind === "failed") failures.push(result);
        return result;
      },
    );
    try {
      const result = await exportDesktopApplication(
        {
          capture: await writeCaptureFolder(capture()),
          directory,
          withheldCopy,
          name: undefined,
          tasks: [],
          withhold: { paths: [SETTINGS] },
        },
        readers,
        controller.signal,
      );
      expect(result).toBeInstanceOf(AnalysisError);
      if (!(result instanceof AnalysisError))
        throw new Error("expected output failure");
      expect(result).toMatchObject({ _tag: "ProviderAdapterError" });
      expect(result.cause).toBeInstanceOf(AggregateError);
      if (!(result.cause instanceof AggregateError))
        throw new Error("expected exact close cause");
      expect(result.cause.errors).toContain(closeFailure);
      expect(result.cleanupPrimary).toBeUndefined();
      expect(result.secondaryFailures).toEqual([
        expect.objectContaining({
          _tag: "AnalysisCancelledError",
          cause: reason,
        }),
      ]);
      expect(result.partialObservation).toMatchObject({
        normalized_result: { directory },
      });
      expect(result.cleanupResources).toEqual([directory]);
      expect(await exists(join(directory, "README.md"))).toBe(true);
      expect(await exists(withheldCopy)).toBe(false);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.owner.resource).toBe(directory);
      closing.mockRestore();
      await failures[0]!.lease.release();
      expect(result.cleanupIncomplete).toBe(false);
      expect(await exists(join(directory, "README.md"))).toBe(true);
    } finally {
      closing.mockRestore();
      for (const failure of failures) await failure.lease.release();
    }
  },
);

it.skipIf(process.platform === "win32")(
  "projects withheld-close cancellation beside both published cleanup owners",
  async () => {
    const root = await createTestTempDirectory("desktop-two-close-cancel-");
    const directory = join(root, "bundle");
    const withheldCopy = join(root, "withheld");
    const controller = new AbortController();
    const reason = new Error(
      "cancel only while closing published withheld copy",
    );
    const bundleClose = new Error("bundle physical descriptor close failed");
    const copyClose = new Error("withheld physical descriptor close failed");
    const failures: Extract<ArtifactCleanupAttempt, { kind: "failed" }>[] = [];
    let isPublished = () => false;
    let closingPublished = false;
    let output = 0;
    const commit = SafeOutputTree.prototype.commit;
    vi.spyOn(SafeOutputTree.prototype, "commit").mockImplementation(
      async function (this: SafeOutputTree, ...args) {
        output += 1;
        isPublished = () => this.published;
        closingPublished = true;
        try {
          return await commit.apply(this, args);
        } finally {
          closingPublished = false;
        }
      },
    );
    const close = OwnedFileHandle.prototype.close;
    const closing = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementation(async function (this: OwnedFileHandle) {
        if (!closingPublished || !isPublished()) return close.call(this);
        if (output === 2) controller.abort(reason);
        throw output === 1 ? bundleClose : copyClose;
      });
    const release = ArtifactResourceScope.prototype.release;
    vi.spyOn(ArtifactResourceScope.prototype, "release").mockImplementation(
      async function (this: ArtifactResourceScope, owner) {
        if (owner.kind === "output-tree") {
          const tree = owner.tree;
          isPublished = () => tree.published;
          closingPublished = true;
        }
        try {
          const result = await release.call(this, owner);
          if (result.kind === "failed") failures.push(result);
          return result;
        } finally {
          if (owner.kind === "output-tree") closingPublished = false;
        }
      },
    );
    try {
      const result = await exportDesktopApplication(
        {
          capture: await writeCaptureFolder(capture()),
          directory,
          withheldCopy,
          name: undefined,
          tasks: [],
          withhold: { paths: [SETTINGS] },
        },
        readers,
        controller.signal,
      );
      if (!(result instanceof AnalysisError))
        throw new Error("expected both cleanup failures");
      expect(output).toBe(2);
      expect(controller.signal.aborted).toBe(true);
      expect(failures).toHaveLength(2);
      for (const { owner } of failures) {
        expect(owner.kind).toBe("output-tree");
        if (owner.kind === "output-tree")
          expect(owner.tree.published).toBe(true);
      }
      for (const cause of [bundleClose, copyClose])
        expect(
          result.secondaryFailures.some(
            (failure) =>
              failure.cause instanceof AggregateError &&
              failure.cause.errors.includes(cause),
          ),
        ).toBe(true);
      expect(projectAnalysisError(result)).toMatchObject({
        code: "cleanup_incomplete",
        category: "execution_failure",
        details: {
          resources: expect.arrayContaining([directory, withheldCopy]),
          partial_observation: { normalized_result: { directory } },
          secondary_failures: expect.arrayContaining([
            expect.objectContaining({ code: "cancelled" }),
          ]),
        },
      });
      const cancellation = result.secondaryFailures.filter(
        (failure) => failure instanceof AnalysisCancelledError,
      );
      expect(cancellation).toHaveLength(1);
      expect(cancellation[0]?.cause).toBe(reason);
      const bundle = failures.find(({ owner }) => owner.resource === directory);
      const copy = failures.find(
        ({ owner }) => owner.resource === withheldCopy,
      );
      if (bundle === undefined || copy === undefined)
        throw new Error("expected exact output owners");
      expect(await readFile(join(withheldCopy, SETTINGS), "utf8")).toBe(
        "[ui]\nwrap=false\n",
      );
      closing.mockRestore();
      await bundle.lease.release();
      expect(result.cleanupIncomplete).toBe(true);
      expect(result.cleanupResources).toEqual([withheldCopy]);
      await copy.lease.release();
      expect(result.cleanupIncomplete).toBe(false);
      expect(await exists(join(directory, "README.md"))).toBe(true);
      expect(await exists(join(withheldCopy, SETTINGS))).toBe(true);
      expect(
        projectAnalysisError(result).details?.secondary_failures,
      ).toContainEqual(expect.objectContaining({ code: "cancelled" }));
    } finally {
      closing.mockRestore();
      for (const failure of failures) await failure.lease.release();
    }
  },
);

it.each(["bundle", "copy"] as const)(
  "retains both published output owners when %s closes first",
  async (first) => {
    const release = ArtifactResourceScope.prototype.release;
    const failures: Extract<ArtifactCleanupAttempt, { kind: "failed" }>[] = [];
    vi.spyOn(ArtifactResourceScope.prototype, "release").mockImplementation(
      async function (this: ArtifactResourceScope, owner) {
        const outcome = await release.call(this, owner);
        if (outcome.kind === "failed") failures.push(outcome);
        return outcome;
      },
    );
    const original = SafeOutputTree.prototype.closeHandles;
    vi.spyOn(SafeOutputTree.prototype, "closeHandles")
      .mockRejectedValueOnce(new Error("bundle close failed"))
      .mockRejectedValueOnce(new Error("copy close failed"))
      .mockImplementation(original);
    const { result, directory, withheldCopy } = await exportWithheld({
      withhold: { paths: [SETTINGS] },
    });
    if (!(result instanceof AnalysisError))
      throw new Error("expected cleanup failure");
    expect(result.cleanupResources).toEqual(
      expect.arrayContaining([directory, withheldCopy]),
    );
    const bundle = failures.find(({ owner }) => owner.resource === directory);
    const copy = failures.find(({ owner }) => owner.resource === withheldCopy);
    if (bundle === undefined || copy === undefined)
      throw new Error("expected both owners");
    await (first === "bundle" ? bundle : copy).lease.release();
    expect(result.cleanupIncomplete).toBe(true);
    expect(result.cleanupResources).toEqual([
      first === "bundle" ? withheldCopy : directory,
    ]);
    await (first === "bundle" ? copy : bundle).lease.release();
    expect(result.cleanupIncomplete).toBe(false);
    expect(projectAnalysisError(result)).toMatchObject({
      details: { partial_observation: { normalized_result: { directory } } },
    });
  },
);

describe("exportDesktopApplication of withheld sign-in state", () => {
  it("leaves a withheld file out of the seed, declares it a secret setting from the environment and copies it aside", async () => {
    const { result, directory, withheldCopy } = await exportWithheld({
      withhold: { paths: [SETTINGS] },
    });

    expect(evidence(result).normalized_result).toMatchObject({
      seed_files: [".local/share/notes/notes.db"],
      withheld_files: [
        {
          file: SETTINGS,
          setting: "config_notes_settings_ini",
          variable: VARIABLE,
          handle: "rea-notes-config-notes-settings-ini",
        },
      ],
      consented_files: [],
    });
    expect(await exists(join(directory, "envs/notes/seed", SETTINGS))).toBe(
      false,
    );
    expect(await readFile(join(withheldCopy, SETTINGS), "utf8")).toBe(
      "[ui]\nwrap=false\n",
    );
    expect(
      await readFile(join(directory, "envs/notes/env.toml"), "utf8"),
    ).toContain(`[settings]\nconfig_notes_settings_ini = "env:${VARIABLE}"\n`);
    const module = await readFile(
      join(directory, "envs/notes/notes_app.py"),
      "utf8",
    );
    expect(module).toContain("from pydantic import SecretStr, create_model");
    expect(module).toContain(
      'Settings = create_model("Settings", __base__=ComputerAppEnvironment.Settings, config_notes_settings_ini=(SecretStr, ...))',
    );
    expect(module).toContain(
      `WITHHELD = {"config_notes_settings_ini": "${SETTINGS}"}`,
    );
    expect(module).toContain(
      "_write_withheld(Path.home(), self.settings, WITHHELD)",
    );
    expect(module).toContain("list(WITHHELD.values())");
    const readme = await readFile(join(directory, "README.md"), "utf8");
    expect(readme).toContain(VARIABLE);
    expect(readme).toContain(`base64 -w0 < "$HOME"/'${SETTINGS}'`);
    expect(await exists(join(directory, "consent.json"))).toBe(false);
  });

  it("refuses to seed withheld files without a consent to it, and with one seeds them and ships the consent", async () => {
    const refused = await exportWithheld({
      withhold: { paths: [SETTINGS] },
      seedWithheld: true,
    });
    expect(refused.result).toBeInstanceOf(Error);
    expect(
      String((refused.result as Error & { userMessage?: string }).userMessage),
    ).toContain("consent");
    expect(await exists(refused.directory)).toBe(false);

    const { root } = refused;
    const consent = join(root, "consent.json");
    await writeFile(consent, JSON.stringify(CONSENT));
    const { result, directory } = await exportWithheld({
      withhold: { paths: [SETTINGS] },
      seedWithheld: true,
      consent,
    });
    expect(evidence(result).normalized_result).toMatchObject({
      seed_files: [SETTINGS, ".local/share/notes/notes.db"],
      withheld_files: [],
      consented_files: [SETTINGS],
    });
    expect(
      JSON.parse(await readFile(join(directory, "consent.json"), "utf8")),
    ).toEqual(CONSENT);
    expect(
      await readFile(join(directory, "envs/notes/env.toml"), "utf8"),
    ).not.toContain("[settings]");
  });

  it("refuses a task whose check names a withheld file", async () => {
    const { result } = await exportWithheld(
      { withhold: { paths: [SETTINGS] } },
      [
        {
          name: "wrap-on",
          prompt: "In Notes, turn line wrapping on.",
          checks: [
            {
              kind: "value_equals",
              file: SETTINGS,
              pointer: "/groups/ui/wrap",
              value: "true",
            },
          ],
        },
      ],
    );
    expect(result).toBeInstanceOf(Error);
    expect(
      String((result as Error & { userMessage?: string }).userMessage),
    ).toContain("withholds");
  });

  it("withholds the files changed in a sign-in window, and the draft leaves them out", async () => {
    const folder = await writeCaptureFolder(capture());
    const window = { from: "baseline", to: "edited" };
    const draft = evidence(
      await draftDesktopApplicationTask(folder, readers, undefined, {
        withhold: window,
      }),
    ).normalized_result as {
      files: { file: string }[];
      withheld_files: string[];
    };
    expect(draft.withheld_files).toEqual([
      SETTINGS,
      ".local/share/notes/notes.db",
      "Documents/today.txt",
    ]);
    expect(draft.files).toEqual([]);
    const { result } = await exportWithheld({ withhold: window });
    expect(evidence(result).normalized_result).toMatchObject({
      seed_files: [],
      withheld_files: [
        { file: SETTINGS },
        { file: ".local/share/notes/notes.db" },
      ],
    });
  });
});

describe("exportDesktopApplication of dconf keys a sign-in changed", () => {
  it("refuses dconf keys the sign-in window changed and the seed holds, unless seeded with consent", async () => {
    const database = `${HOME}/.config/dconf/user`;
    // Made-up dconf databases by their bytes, and the keys each dumps.
    const dumps: Readonly<Record<string, string>> = {
      "GVariant signed out": "[org/notes]\nwrap=true\n",
      "GVariant signed in": "[org/notes]\nwrap=true\nsession='e-made-up'\n",
    };
    const [out = "", signed = ""] = Object.keys(dumps);
    const dconfReaders = {
      ...readers,
      dconf: async (path: string) => ({
        ok: true as const,
        text: dumps[await readFile(path, "utf8")] ?? "",
      }),
    };
    /** The notes capture signing in between its window's checkpoints, with the database at `seeded` by the seed. */
    const signedIn = (seeded: string) => {
      const base = capture();
      const [first, edited] = base.state.checkpoints;
      if (first === undefined || edited === undefined)
        throw new Error("fixture");
      const reset =
        seeded === signed
          ? []
          : [change(database, { before: signed, after: seeded })];
      return {
        capture: {
          ...base,
          state: {
            ...base.state,
            checkpoints: [
              {
                ...first,
                retained: [...first.retained, retained(database, out)],
              },
              checkpoint("pre-sign-in", "request", [], []),
              checkpoint(
                "post-sign-in",
                "request",
                [change(database, { before: out, after: signed })],
                [retained(database, signed)],
              ),
              checkpoint(
                "seed",
                "request",
                reset,
                reset.length === 0 ? [] : [retained(database, seeded)],
              ),
              { ...edited, name: "end" },
            ],
          },
        },
        content: [out, signed],
      };
    };
    const options = {
      withhold: { from: "pre-sign-in", to: "post-sign-in" },
      seedCheckpoint: "seed",
      endCheckpoint: "end",
    };
    const refused = await exportWithheld(
      options,
      [],
      signedIn(signed),
      dconfReaders,
    );
    expect(refused.result).toBeInstanceOf(Error);
    const message = String(
      (refused.result as Error & { userMessage?: string }).userMessage,
    );
    expect(message).toContain("org/notes/session");
    expect(message).not.toContain("e-made-up");
    expect(await exists(refused.directory)).toBe(false);

    // Signed out again before the seed, the keys ship as they were before the sign-in.
    const reset = await exportWithheld(
      options,
      [],
      signedIn(out),
      dconfReaders,
    );
    expect(reset.result).not.toBeInstanceOf(Error);

    const consent = join(refused.root, "consent.json");
    await writeFile(consent, JSON.stringify(CONSENT));
    const seeded = await exportWithheld(
      { ...options, seedWithheld: true, consent },
      [],
      signedIn(signed),
      dconfReaders,
    );
    expect(seeded.result).not.toBeInstanceOf(Error);
    expect(
      await readFile(join(seeded.directory, "envs/notes/notes_app.py"), "utf8"),
    ).toContain("session=");
  });
});

describe("exportDesktopApplication of withheld paths and copies", () => {
  it("withholds a file however its path is spelled, every file of a folder named, and refuses a path that names none", async () => {
    for (const spelling of [
      ".config/notes/./settings.ini",
      ".config//notes/settings.ini",
      `${HOME}/.config/notes/settings.ini`,
      "~/.config/notes/settings.ini",
    ]) {
      const { result } = await exportWithheld({
        withhold: { paths: [spelling] },
      });
      expect(evidence(result).normalized_result, spelling).toMatchObject({
        seed_files: [".local/share/notes/notes.db"],
        withheld_files: [{ file: SETTINGS }],
      });
    }
    const folder = await exportWithheld({
      withhold: { paths: [".config/notes"] },
    });
    expect(evidence(folder.result).normalized_result).toMatchObject({
      withheld_files: [{ file: SETTINGS }],
    });
    for (const path of [
      ".config/notes/absent.ini",
      ".config/notes/../../.bashrc",
    ]) {
      const { result, directory } = await exportWithheld({
        withhold: { paths: [path] },
      });
      expect(result, path).toBeInstanceOf(Error);
      expect(await exists(directory)).toBe(false);
    }
  });

  it("refuses a withheld file too large for its setting, with no copy asked for", async () => {
    // A made-up settings file past the 48 KiB a setting takes back.
    const large = `[ui]\nnote=${"x".repeat(50 * 1024)}\n`;
    const { result, directory } = await exportWithheld(
      { withhold: { paths: [SETTINGS] }, withheldCopy: undefined },
      [],
      { capture: withSettings(large), content: [large] },
    );
    expect(result).toBeInstanceOf(Error);
    expect(
      String((result as Error & { userMessage?: string }).userMessage),
    ).toContain("49152");
    expect(await exists(directory)).toBe(false);
  });
});

describe("exportDesktopApplication withheld copy destinations", () => {
  it("refuses a withheld copy inside the bundle, also through a link, and writes neither", async () => {
    const root = await createTestTempDirectory("desktop-withheld-inside-");
    const directory = join(root, "bundle");
    const inside = await exportWithheld({
      withhold: { paths: [SETTINGS] },
      directory,
      withheldCopy: join(directory, "private"),
    });
    expect(inside.result).toBeInstanceOf(Error);
    expect(await exists(directory)).toBe(false);
    await mkdir(directory);
    await symlink(directory, join(root, "alias"));
    const linked = await exportWithheld({
      withhold: { paths: [SETTINGS] },
      directory,
      withheldCopy: join(root, "alias", "private"),
    });
    expect(linked.result).toBeInstanceOf(Error);
    expect(await readdir(directory)).toEqual([]);
    await mkdir(join(root, "outside"));
    await symlink(directory, join(root, "outside", "link"));
    const parentTraversal = await exportWithheld({
      withhold: { paths: [SETTINGS] },
      directory,
      withheldCopy: `${root}/outside/link/../bundle/private`,
    });
    expect(parentTraversal.result).toBeInstanceOf(Error);
    expect(await readdir(directory)).toEqual([]);
    const unresolved = await exportWithheld({
      withhold: { paths: [SETTINGS] },
      directory: join(root, "new-bundle"),
      withheldCopy: `${root}/missing/../private`,
    });
    expect(unresolved.result).toBeInstanceOf(Error);
    expect(await exists(join(root, "missing"))).toBe(false);
    expect(await exists(join(root, "new-bundle"))).toBe(false);
    await symlink(join(root, "absent"), join(root, "dangling"));
    const dangling = await exportWithheld({
      withhold: { paths: [SETTINGS] },
      directory: join(root, "new-bundle"),
      withheldCopy: join(root, "dangling", "private"),
    });
    expect(dangling.result).toBeInstanceOf(AnalysisError);
    expect(await exists(join(root, "new-bundle"))).toBe(false);
    const leafLink = await exportWithheld({
      withhold: { paths: [SETTINGS] },
      directory: `${root}/alias//`,
      withheldCopy: join(root, "outside-copy"),
    });
    expect(leafLink.result).toBeInstanceOf(Error);
    expect(await readdir(directory)).toEqual([]);
  });

  it("reports a written copy whose handles cannot be closed, with the export's Evidence", async () => {
    const original = Object.getOwnPropertyDescriptor(
      SafeOutputTree.prototype,
      "closeHandles",
    )?.value as SafeOutputTree["closeHandles"];
    const bundleTree = new Set<SafeOutputTree>();
    vi.spyOn(SafeOutputTree.prototype, "closeHandles").mockImplementation(
      async function (this: SafeOutputTree) {
        if (bundleTree.size === 0) bundleTree.add(this);
        if (bundleTree.has(this)) return original.apply(this);
        throw new Error("close failed");
      },
    );
    const { result, withheldCopy } = await exportWithheld({
      withhold: { paths: [SETTINGS] },
    });
    expect(result).toMatchObject({
      _tag: "ProviderAdapterError",
      cleanup: { resources: [withheldCopy] },
      partialObservation: { operation: "export_desktop_application" },
    });
    expect(await readFile(join(withheldCopy, SETTINGS), "utf8")).toBe(
      "[ui]\nwrap=false\n",
    );
  });

  it("refuses a seed file holding a withheld file's bytes under another name, naming both, and seeds a backup that differs", async () => {
    // Made-up database bytes, never a real vault.
    const database = "e-made-up-kdbx-bytes-0001";
    const copied = await exportWithheld(
      { withhold: { paths: ["Documents/e-test.kdbx"] } },
      [],
      { capture: withBackup(database, database), content: [database] },
    );
    expect(copied.result).toBeInstanceOf(Error);
    const message = String(
      (copied.result as Error & { userMessage?: string }).userMessage,
    );
    expect(message).toContain("Documents/e-test.kdbx.bak");
    expect(message).toContain("a copy of Documents/e-test.kdbx");
    expect(message).not.toContain(database);
    expect(await exists(copied.directory)).toBe(false);
    const older = "e-made-up-kdbx-bytes-0000";
    const differs = await exportWithheld(
      { withhold: { paths: ["Documents/e-test.kdbx"] } },
      [],
      { capture: withBackup(database, older), content: [database, older] },
    );
    expect(evidence(differs.result).normalized_result).toMatchObject({
      withheld_files: [{ file: "Documents/e-test.kdbx" }],
    });
    expect(
      (evidence(differs.result).normalized_result as { seed_files: string[] })
        .seed_files,
    ).toContain("Documents/e-test.kdbx.bak");
  });
});
