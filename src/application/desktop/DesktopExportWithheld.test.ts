import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import type { Evidence } from "../../domain/evidence.js";
import { exportDesktopApplication } from "./DesktopApplicationExport.js";
import { draftDesktopApplicationTask } from "./DesktopTaskDraft.js";
import {
  capture,
  readers,
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

/** Export the notes capture with `options`, into a fresh folder beside a folder for the withheld copies. */
const exportWithheld = async (
  options: Record<string, unknown>,
  tasks: readonly unknown[] = [],
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
      capture: await writeCaptureFolder(capture()),
      directory,
      name: undefined,
      tasks: taskPaths,
      withheldCopy,
      ...options,
    },
    readers,
  );
  return { result, directory, withheldCopy, root };
};

const evidence = (result: Evidence | Error): Evidence => {
  if (result instanceof Error) throw result;
  return result;
};

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
    expect(readme).toContain(`base64 -w0 < ~/${SETTINGS}`);
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
