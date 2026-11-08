import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { Client } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";

import {
  change,
  checkpoint,
  retained,
  seedEndCapture,
} from "../../../src/application/desktop/desktopCapture.fixture.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import type { DesktopApplicationCapture } from "../../../src/domain/desktop/desktopCapture.js";
import {
  BUILD_REQUEST as REQUEST,
  BUILD_TASK as TASK,
  buildCaptureFakes,
} from "../../fixtures/buildCaptureFakes.js";
import {
  buildComputerFakes,
  bundleFolder,
  callOk,
  connectBuildServer,
  startBuildComputer,
} from "../../fixtures/buildComputerMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const HOME = "/home/ada";
const SETTINGS = ".config/notes/settings.ini";
const VARIABLE = "REA_NOTES_CONFIG_NOTES_SETTINGS_INI";
const HANDLE = "rea-notes-config-notes-settings-ini";
// A made-up key in the shape KeePassXC writes its generated KeeShare key, never a real one.
const FAKE_KEY_BODY =
  "Zm9yLXRlc3RzLW9ubHktbm90LWEta2V5LXRoaXMtaXMtbWFkZS11cC1ieS1yZWEtdGVzdHMtMDAwMDAwMDAwMDAwMDAwMDAw";
const KEY_INI = `[KeeShare]\nOwn="<?xml version=\\"1.0\\"?><KeeShare><PrivateKey>MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQ${FAKE_KEY_BODY}</PrivateKey></KeeShare>"\n`;

/** The seed-and-end capture with its checkpoints before `seed` replaced: the baseline keeping the settings as `settings`, then `before`. */
const recordedWith = (
  settings: string,
  before: ReturnType<typeof checkpoint>[] = [],
  endSettings?: string,
): DesktopApplicationCapture => {
  const base = seedEndCapture();
  const [, seed, end, ...rest] = base.state.checkpoints;
  if (seed === undefined || end === undefined) throw new Error("fixture");
  const ended =
    endSettings === undefined
      ? end
      : checkpoint(
          "end",
          "request",
          [
            change(
              `${HOME}/${SETTINGS}`,
              { before: settings, after: endSettings },
              { state: true },
            ),
          ],
          [retained(`${HOME}/${SETTINGS}`, endSettings)],
        );
  return {
    ...base,
    state: {
      ...base.state,
      checkpoints: [
        checkpoint(
          "baseline",
          "baseline",
          [],
          [retained(`${HOME}/${SETTINGS}`, settings)],
        ),
        ...before,
        endSettings === undefined
          ? seed
          : checkpoint("seed", "request", [], []),
        ended,
        ...rest.filter((at) => endSettings === undefined || at.name !== "exit"),
      ],
    },
  };
};

const captureThrough = async (
  client: Client,
  id: string,
  names: readonly string[],
) => {
  await callOk(client, "start_build_capture", { computer_id: id });
  for (const name of names)
    await callOk(client, "mark_build_checkpoint", { computer_id: id, name });
  return toolContract("stop_build_capture").outputSchema.parse(
    (await callOk(client, "stop_build_capture", { computer_id: id }))
      .structuredContent,
  );
};

const exportTo = async (
  client: Client,
  id: string,
  fields: Record<string, unknown> = {},
) => {
  const directory = join(await createTestTempDirectory("build-out-"), "notes");
  const result = (await client.callTool({
    name: "export_build_environment",
    arguments: { computer_id: id, task: TASK, directory, ...fields },
  })) as CallToolResult;
  return { result, directory };
};

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

it("withholds a file the agent names, keeps its bytes in a secret file only the person reads, and supplies it to a witness", async () => {
  const config = await createTestTempDirectory("xdg-config-");
  const { client, rea } = await buildCaptureFakes({
    serverEnv: { XDG_CONFIG_HOME: config },
    exportArgs: ["--withhold-path", SETTINGS],
  });
  const id = await startBuildComputer(client, REQUEST);
  await captureThrough(client, id, ["seed", "end"]);
  const { result } = await exportTo(client, id, { withhold: [SETTINGS] });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  const exported = toolContract("export_build_environment").outputSchema.parse(
    result.structuredContent,
  );
  expect(exported.withheld_files).toEqual([
    { file: SETTINGS, variable: VARIABLE, handle: HANDLE },
  ]);
  const argv =
    ((await rea.notes("calls.jsonl")) as { argv: string[] }[]).at(-1)?.argv ??
    [];
  expect(argv).toEqual(
    expect.arrayContaining(["--withhold-path", SETTINGS, "--withheld-copy"]),
  );
  const value = Buffer.from("[ui]\nwrap=false\n").toString("base64");
  const file = join(config, "rea", "build-secrets", HANDLE);
  expect(await readFile(file, "utf8")).toBe(value);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(result)).not.toContain(value);

  // A witness of the bundle takes the setting from that secret file, by its handle.
  const { computer, runner } = await buildComputerFakes();
  const witness = await connectBuildServer({
    ...runner.environment,
    XDG_CONFIG_HOME: config,
  });
  const started = await witness.callTool({
    name: "start_build_computer",
    arguments: {
      source: {
        kind: "bundle",
        path: await bundleFolder(computer),
        settings: { [VARIABLE]: HANDLE },
      },
    },
  });
  expect(started.isError, JSON.stringify(started)).not.toBe(true);
  expect((await runner.notes("settings.jsonl"))[0]).toMatchObject({
    [VARIABLE]: sha256(value),
  });
  const unsafe = await witness.callTool({
    name: "start_build_computer",
    arguments: {
      source: {
        kind: "bundle",
        path: await bundleFolder(computer),
        settings: { LD_PRELOAD: HANDLE },
      },
    },
  });
  expect(parseMcpToolError(unsafe as CallToolResult).error.code).toBe(
    "invalid_request",
  );
});

it("keeps a later build's withheld bytes under a handle of their own, leaving an earlier build's secret as it was", async () => {
  const config = await createTestTempDirectory("xdg-config-");
  const folder = join(config, "rea", "build-secrets");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const earlier = Buffer.from("[ui]\nwrap=true\n").toString("base64");
  await writeFile(join(folder, HANDLE), earlier, { mode: 0o600 });
  const { client } = await buildCaptureFakes({
    serverEnv: { XDG_CONFIG_HOME: config },
    exportArgs: ["--withhold-path", SETTINGS],
  });
  const id = await startBuildComputer(client, REQUEST);
  await captureThrough(client, id, ["seed", "end"]);
  const kept = async () => {
    const { result } = await exportTo(client, id, { withhold: [SETTINGS] });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return toolContract("export_build_environment").outputSchema.parse(
      result.structuredContent,
    ).withheld_files;
  };
  const own = `${HANDLE}-2`;
  expect(await kept()).toEqual([
    { file: SETTINGS, variable: VARIABLE, handle: own },
  ]);
  expect(await readFile(join(folder, HANDLE), "utf8")).toBe(earlier);
  expect(await readFile(join(folder, own), "utf8")).toBe(
    Buffer.from("[ui]\nwrap=false\n").toString("base64"),
  );
  // Exported again, the same bytes keep the handle they already have.
  expect((await kept())[0]?.handle).toBe(own);
  expect((await readdir(folder)).sort()).toEqual([HANDLE, own]);
});

it("records the person's consent, seeds withheld state only with it, and passes the sign-in window to the draft and the export", async () => {
  const signIn = [
    checkpoint("pre-sign-in", "request", [], []),
    checkpoint("post-sign-in", "request", [], []),
  ];
  const { client, rea } = await buildCaptureFakes({
    recorded: recordedWith("[ui]\nwrap=false\n", signIn),
  });
  const id = await startBuildComputer(client, REQUEST);
  await captureThrough(client, id, [
    "pre-sign-in",
    "post-sign-in",
    "seed",
    "end",
  ]);
  const window = [
    "--withhold-from",
    "pre-sign-in",
    "--withhold-to",
    "post-sign-in",
  ];
  const calls = async () =>
    (await rea.notes("calls.jsonl")) as { argv: string[] }[];
  expect((await calls()).at(-1)?.argv).toEqual(expect.arrayContaining(window));

  const refused = await exportTo(client, id, { seed_sign_in: true });
  expect(parseMcpToolError(refused.result).error.message).toContain(
    "record_build_consent",
  );
  const recorded = await callOk(client, "record_build_consent", {
    computer_id: id,
    kind: "seed_sign_in",
    subject: "the notes app's signed-in settings",
    words: "Yes, put my signed-in settings in the bundle.",
  });
  expect(
    toolContract("record_build_consent").outputSchema.parse(
      recorded.structuredContent,
    ),
  ).toMatchObject({
    consent: { kind: "seed_sign_in", source: "relayed" },
    consents: 1,
  });
  const { result } = await exportTo(client, id, { seed_sign_in: true });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  const argv = (await calls()).at(-1)?.argv ?? [];
  expect(argv).toEqual(
    expect.arrayContaining([...window, "--seed-withheld", "--consent"]),
  );
  const written = argv[argv.indexOf("--consent") + 1] ?? "";
  const consent = JSON.parse(
    await readFile(
      isAbsolute(written) ? written : join(rea.home, written),
      "utf8",
    ),
  ) as { consents: unknown[] };
  expect(consent.consents).toEqual([
    expect.objectContaining({
      kind: "seed_sign_in",
      words: "Yes, put my signed-in settings in the bundle.",
    }),
  ]);
});

it("refuses an export when only one sign-in checkpoint was marked", async () => {
  const { client } = await buildCaptureFakes({
    recorded: recordedWith("[ui]\nwrap=false\n", [
      checkpoint("pre-sign-in", "request", [], []),
    ]),
  });
  const id = await startBuildComputer(client, REQUEST);
  await captureThrough(client, id, ["pre-sign-in", "seed", "end"]);
  const { result } = await exportTo(client, id);
  expect(parseMcpToolError(result).error.message).toContain("post-sign-in");
});

it("refuses a bundle whose seed holds a credential by its shape, naming the file and its kind but not the value", async () => {
  const { client } = await buildCaptureFakes({
    recorded: recordedWith(KEY_INI),
    extraContent: [KEY_INI],
  });
  const id = await startBuildComputer(client, REQUEST);
  await captureThrough(client, id, ["seed", "end"]);
  const { result, directory } = await exportTo(client, id);
  const { error } = parseMcpToolError(result);
  expect(error.message).toContain(`envs/notes/seed/${SETTINGS}`);
  expect(error.message).toContain("private-key");
  expect(JSON.stringify(result)).not.toContain(FAKE_KEY_BODY);
  expect(await readdir(directory).catch(() => [])).toEqual([]);
});

it("shows a credential in the draft by its kind, never its value", async () => {
  const { client } = await buildCaptureFakes({
    recorded: recordedWith("[ui]\nwrap=false\n", [], KEY_INI),
    extraContent: [KEY_INI],
    exportRefused: true,
  });
  const id = await startBuildComputer(client, REQUEST);
  const stopped = await captureThrough(client, id, ["seed", "end"]);
  const drafted = JSON.stringify(stopped.draft);
  expect(drafted).toContain("<credential:private-key>");
  expect(drafted).not.toContain(FAKE_KEY_BODY);
});
