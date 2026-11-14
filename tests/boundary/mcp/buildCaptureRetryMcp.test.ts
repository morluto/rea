import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { Client } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";

import { seedEndCapture } from "../../../src/application/desktop/desktopCapture.fixture.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import type { DesktopApplicationCapture } from "../../../src/domain/desktop/desktopCapture.js";
import {
  VARICAD_URL,
  varicadPackage,
} from "../../../src/domain/desktop/debianPackageFile.fixture.js";
import {
  BUILD_REQUEST,
  BUILD_TASK,
  buildCaptureFakes as fakes,
} from "../../fixtures/buildCaptureFakes.js";
import { callOk, startBuildComputer } from "../../fixtures/buildComputerMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { cancelDuringCommit } from "../../fixtures/outputTreeCommit.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { waitFor } from "../../support/testWait.js";

const call = (client: Client, name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args });

/** Start a capture on the computer and mark seed and end. */
const captureSeedAndEnd = async (client: Client, id: string) => {
  await callOk(client, "start_build_capture", { computer_id: id });
  for (const name of ["seed", "end"])
    await callOk(client, "mark_build_checkpoint", { computer_id: id, name });
};

const captureCalls = async (
  rea: Awaited<ReturnType<typeof fakes>>["rea"],
): Promise<string[][]> =>
  ((await rea.notes("calls.jsonl")) as { argv: string[] }[])
    .map(({ argv }) => argv)
    .filter((argv) => argv[0] === "capture-desktop-application");

it("stops a capture whose start reply was lost, and retries that stop before starting another", async () => {
  const { rea, client } = await fakes({
    dropReplies: ["start", "stop", "stop"],
  });
  const id = await startBuildComputer(client, BUILD_REQUEST);
  // The capture started in the computer, but REA never heard so.
  const lost = parseMcpToolError(
    await call(client, "start_build_capture", { computer_id: id }),
  );
  expect(lost.error.code).not.toBe("invalid_request");
  // Its stop ran too, unheard; REA keeps the capture until a stop is confirmed.
  const unconfirmed = parseMcpToolError(
    await call(client, "start_build_capture", { computer_id: id }),
  );
  expect(unconfirmed.error.message).toContain("captures/1");
  expect(await captureCalls(rea)).toHaveLength(1);
  // The third stop is heard: the first capture is released, and a new one starts.
  const started = await callOk(client, "start_build_capture", {
    computer_id: id,
  });
  expect(started.structuredContent).toMatchObject({ package_lists: 1 });
  const calls = await captureCalls(rea);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toContain(join(rea.home, ".rea-build/captures/2/capture"));
  expect(await rea.notes("stopped.jsonl")).toHaveLength(1);
  await callOk(client, "stop_build_capture", { computer_id: id });
});

it("returns a checkpoint taken in the computer when its reply was lost and the name is asked again", async () => {
  const { client } = await fakes({ dropReplies: ["mark"] });
  const id = await startBuildComputer(client, BUILD_REQUEST);
  await callOk(client, "start_build_capture", { computer_id: id });
  const mark = (name: string) =>
    call(client, "mark_build_checkpoint", { computer_id: id, name });
  expect(parseMcpToolError(await mark("seed")).error.code).not.toBe(
    "invalid_request",
  );
  const retried = await mark("seed");
  expect(retried.isError, JSON.stringify(retried)).not.toBe(true);
  expect(retried.structuredContent).toMatchObject({
    checkpoint: { name: "seed", at_ms: 1000, changes: 1 },
  });
  await callOk(client, "mark_build_checkpoint", {
    computer_id: id,
    name: "end",
  });
  const stopped = await callOk(client, "stop_build_capture", {
    computer_id: id,
  });
  expect(stopped.structuredContent).toMatchObject({
    draft: { seed_checkpoint: "seed", end_checkpoint: "end" },
  });
});

it("finishes a stop whose draft reply was lost when stop is asked again, and repeats its result", async () => {
  const { rea, client } = await fakes({
    dropReplies: ["run:describe-desktop-application-task"],
  });
  const id = await startBuildComputer(client, BUILD_REQUEST);
  await captureSeedAndEnd(client, id);
  const stop = () => call(client, "stop_build_capture", { computer_id: id });
  expect((await stop()).isError).toBe(true);
  const first = await stop();
  expect(first.isError, JSON.stringify(first)).not.toBe(true);
  const stopped = toolContract("stop_build_capture").outputSchema.parse(
    first.structuredContent,
  );
  expect(stopped.draft?.files).toEqual([
    expect.objectContaining({ file: "Documents/today.txt" }),
  ]);
  expect((await stop()).structuredContent).toEqual(first.structuredContent);
  expect(await rea.notes("stopped.jsonl")).toHaveLength(1);
  const exported = await call(client, "export_build_environment", {
    computer_id: id,
    tasks: [{ task: BUILD_TASK }],
    directory: join(await createTestTempDirectory("build-out-"), "bundle"),
  });
  expect(exported.isError, JSON.stringify(exported)).not.toBe(true);
});

it("reports a failed package list download with apt's own message", async () => {
  const { client } = await fakes({ env: { FAKE_APT_EXIT: "100" } });
  const id = await startBuildComputer(client, BUILD_REQUEST);
  const started = await callOk(client, "start_build_capture", {
    computer_id: id,
  });
  const value = toolContract("start_build_capture").outputSchema.parse(
    started.structuredContent,
  );
  expect(value.package_lists).toBe(0);
  expect(value.package_lists_error).toContain("exited 100");
  expect(value.package_lists_error).toContain("Failed to fetch");
  await callOk(client, "stop_build_capture", { computer_id: id });
});

it("downloads the package lists again when an update exits 0 with no list", async () => {
  const { client, rea } = await fakes({
    env: { FAKE_APT_EMPTY: "1", FAKE_APT_IGNORE_ERROR_MODE: "1" },
  });
  const id = await startBuildComputer(client, BUILD_REQUEST);
  for (const attempt of [1, 2]) {
    const value = toolContract("start_build_capture").outputSchema.parse(
      (await callOk(client, "start_build_capture", { computer_id: id }))
        .structuredContent,
    );
    expect(value.package_lists, `start ${String(attempt)}`).toBe(0);
    expect(value.package_lists_error, `start ${String(attempt)}`).toContain(
      "without a package list",
    );
    expect(await rea.notes("apt.jsonl")).toHaveLength(attempt);
    await callOk(client, "stop_build_capture", { computer_id: id });
  }
});

it("retries an empty apt update that Error-Mode turns into a failure", async () => {
  const { client, rea } = await fakes({ env: { FAKE_APT_EMPTY: "1" } });
  const id = await startBuildComputer(client, BUILD_REQUEST);
  for (const attempt of [1, 2]) {
    const value = toolContract("start_build_capture").outputSchema.parse(
      (await callOk(client, "start_build_capture", { computer_id: id }))
        .structuredContent,
    );
    expect(value.package_lists, `start ${String(attempt)}`).toBe(0);
    expect(value.package_lists_error, `start ${String(attempt)}`).toContain(
      "exited 100",
    );
    expect(await rea.notes("apt.jsonl")).toHaveLength(attempt);
    await callOk(client, "stop_build_capture", { computer_id: id });
  }
});

it("downloads the package lists again on the next start after an update that fetched some and failed", async () => {
  const { client, rea } = await fakes({
    env: { FAKE_APT_EXIT: "100", FAKE_APT_PARTIAL: "1" },
  });
  const id = await startBuildComputer(client, BUILD_REQUEST);
  for (const attempt of [1, 2]) {
    const value = toolContract("start_build_capture").outputSchema.parse(
      (await callOk(client, "start_build_capture", { computer_id: id }))
        .structuredContent,
    );
    expect(value.package_lists, `start ${String(attempt)}`).toBe(1);
    expect(value.package_lists_error, `start ${String(attempt)}`).toContain(
      "exited 100",
    );
    expect(await rea.notes("apt.jsonl")).toHaveLength(attempt);
    await callOk(client, "stop_build_capture", { computer_id: id });
  }
});

it("releases a capture whose start was cancelled after launch, so another start can run", async () => {
  const { computer, client } = await fakes({
    screenshotDelaysMs: [0, 60_000],
  });
  const id = await startBuildComputer(client, BUILD_REQUEST);
  const screenshots = () =>
    computer.calls.filter(({ name }) => name === "computer_screenshot").length;
  const controller = new AbortController();
  const started = client.callTool(
    { name: "start_build_capture", arguments: { computer_id: id } },
    { signal: controller.signal },
  );
  await waitFor(() => expect(screenshots()).toBe(2));
  controller.abort();
  await expect(started).rejects.toThrow();
  const again = await callOk(client, "start_build_capture", {
    computer_id: id,
  });
  expect(again.structuredContent).toMatchObject({ package_lists: 1 });
});

it("stops a detached capture when the computer closes", async () => {
  const { rea, client, computer } = await fakes();
  const id = await startBuildComputer(client, BUILD_REQUEST);
  await callOk(client, "start_build_capture", { computer_id: id });
  const running = () =>
    execFileSync("ps", ["-eo", "args="], { encoding: "utf8" })
      .split("\n")
      .filter(
        (line) =>
          line.includes(rea.home) &&
          line.includes("capture-desktop-application"),
      );
  expect(running().length).toBeGreaterThan(0);
  await computer.close();
  expect(running()).toEqual([]);
});

it("cancels a capture's start when the computer closes while it waits for the opened app's screenshot", async () => {
  // The start's own screenshot answers at once; the capture's waits until its request is cancelled.
  const { computer, client } = await fakes({ screenshotDelaysMs: [0, 60_000] });
  const id = await startBuildComputer(client, BUILD_REQUEST);
  const screenshots = () =>
    computer.calls.filter(({ name }) => name === "computer_screenshot").length;
  expect(screenshots()).toBe(1);
  const started = call(client, "start_build_capture", { computer_id: id });
  await waitFor(() => expect(screenshots()).toBe(2));
  await callOk(client, "close_build_computer", { computer_id: id });
  expect(parseMcpToolError(await started).error.code).toBe("cancelled");
});

it("reports cancellation and the published bundle when the computer closes during commit", async () => {
  const { client } = await fakes();
  const id = await startBuildComputer(client, BUILD_REQUEST);
  await captureSeedAndEnd(client, id);
  await callOk(client, "stop_build_capture", { computer_id: id });
  const directory = join(await createTestTempDirectory("build-out-"), "bundle");
  let closed: Promise<unknown> = Promise.resolve();
  cancelDuringCommit(() => {
    closed = call(client, "close_build_computer", { computer_id: id });
  });
  const exported = await call(client, "export_build_environment", {
    computer_id: id,
    tasks: [{ task: BUILD_TASK }],
    directory,
  });
  expect(parseMcpToolError(exported).error).toMatchObject({
    code: "cancelled",
    details: {
      diagnostics: {
        published_bundle: { directory, files: expect.any(Number) },
      },
    },
  });
  expect((await readdir(directory)).length).toBeGreaterThan(0);
  await closed;
});

/** Capture and export an app the request installs with `install`; the start's result, the bundle's folder and the stand-in's argv for a command. */
const captureRequest = async (
  { rea, client }: Awaited<ReturnType<typeof fakes>>,
  install: Record<string, unknown>,
) => {
  const started = toolContract("start_build_computer").outputSchema.parse(
    (
      await callOk(client, "start_build_computer", {
        source: {
          kind: "request",
          desktop_entry: "org.example.notes",
          install,
        },
      })
    ).structuredContent,
  );
  const id = started.computer_id;
  await captureSeedAndEnd(client, id);
  await callOk(client, "stop_build_capture", { computer_id: id });
  const directory = join(await createTestTempDirectory("build-out-"), "bundle");
  const exported = toolContract("export_build_environment").outputSchema.parse(
    (
      await callOk(client, "export_build_environment", {
        computer_id: id,
        tasks: [{ task: BUILD_TASK }],
        directory,
      })
    ).structuredContent,
  );
  const calls = ((await rea.notes("calls.jsonl")) as { argv: string[] }[]).map(
    ({ argv }) => argv,
  );
  const argv = (command: string) =>
    calls.find(
      (candidate) =>
        candidate[0] === command && !candidate.includes("--schema"),
    ) ?? [];
  return { started, exported, directory, argv };
};

/** Capture and export an app the request installs from a .deb at `url` after `dependencies`; the stand-in's export argv. */
const captureDebRequest = async (
  fakeSet: Awaited<ReturnType<typeof fakes>>,
  url: string,
  dependencies: readonly string[] = [],
) => {
  const { started, exported, directory, argv } = await captureRequest(fakeSet, {
    kind: "package_file",
    url,
    sha256: "0".repeat(64),
    architecture: "amd64",
    dependencies,
  });
  expect(argv("capture-desktop-application")).toEqual(
    expect.arrayContaining(["--package-file", "/opt/rea/package.deb"]),
  );
  return {
    started,
    exported,
    directory,
    exportArgv: argv("export-desktop-application"),
  };
};

/** The values given to each `--extra-package` in an argv, in order. */
const extraPackageFlags = (argv: readonly string[]) =>
  argv.flatMap((value, index) =>
    value === "--extra-package" ? [argv[index + 1]] : [],
  );

it("exports an app from its .deb file, at the request's URL, when no apt source offers it", async () => {
  const { exported, exportArgv } = await captureDebRequest(
    await fakes({
      install: { package: varicadPackage(), packageUrl: VARICAD_URL },
    }),
    VARICAD_URL,
  );

  expect(exportArgv).toEqual(
    expect.arrayContaining(["--package-url", VARICAD_URL]),
  );
  expect(exported.files).toBeGreaterThan(0);
});

it("exports an app from apt, without the .deb's URL, when an apt source offers the captured version too, keeping its dependencies beside it", async () => {
  // The capture found notes in noble/universe, so the export installs it by
  // name; as MyPaint's, its request named librsvg2-common, which GTK only recommends.
  const { started, exported, directory, exportArgv } = await captureDebRequest(
    await fakes({ install: { extraPackages: ["librsvg2-common"] } }),
    "https://downloads.example.com/notes_1.0_amd64.deb",
    ["librsvg2-common"],
  );

  expect(started.extra_packages).toEqual(["librsvg2-common"]);
  expect(exportArgv).not.toContain("--package-url");
  expect(extraPackageFlags(exportArgv)).toEqual(["librsvg2-common"]);
  expect(
    await readFile(join(directory, "envs/notes/notes_app.py"), "utf8"),
  ).toContain('packages=Packages(apt=["notes", "librsvg2-common"])');
  expect(
    exported.limitations.filter((line) => line.includes("librsvg2-common")),
  ).toHaveLength(1);
});

it("passes an archive request's extra packages to the export, whose bundle installs them beside the app", async () => {
  const { exported, directory, argv } = await captureRequest(
    await fakes({ install: { extraPackages: ["openjdk-17-jre"] } }),
    { kind: "archive", package: "notes", extra_packages: ["openjdk-17-jre"] },
  );

  expect(extraPackageFlags(argv("export-desktop-application"))).toEqual([
    "openjdk-17-jre",
  ]);
  expect(
    await readFile(join(directory, "envs/notes/notes_app.py"), "utf8"),
  ).toContain('packages=Packages(apt=["notes", "openjdk-17-jre"])');
  expect(
    exported.limitations.filter((line) => line.includes("openjdk-17-jre")),
  ).toHaveLength(1);
});

it("passes an AppImage request's download to the export in a file, whose bundle downloads and extracts the app", async () => {
  const appRun = "/opt/rea-apps/org.example.notes/squashfs-root/AppRun";
  const base = seedEndCapture();
  const recorded: DesktopApplicationCapture = {
    ...base,
    application: {
      ...base.application,
      desktop_entry: {
        id: "org.example.notes",
        path: "/usr/local/share/applications/org.example.notes.desktop",
        name: "Notes",
        exec: `${appRun} %F`,
        icon: null,
        startup_wm_class: null,
        categories: [],
        mime_types: [],
        terminal: false,
      },
      argv: [appRun],
      executable: { path: appRun, resolved_path: appRun, electron_markers: [] },
      package: {
        kind: "unknown",
        name: null,
        version: null,
        architecture: null,
        sources: [],
        package_lists_present: null,
      },
    },
  };
  const download = {
    url: "https://downloads.example.com/notes-2.0-x86_64.AppImage",
    sha256: "f".repeat(64),
    architecture: "amd64",
  };
  const fakeSet = await fakes({
    recorded,
    install: {
      downloadInstall: {
        kind: "appimage",
        desktop_entry: "org.example.notes",
        ...download,
      },
    },
  });
  const { directory, argv } = await captureRequest(fakeSet, {
    kind: "appimage",
    ...download,
  });

  const exportCall = (
    (await fakeSet.rea.notes("calls.jsonl")) as {
      argv: string[];
      cwd: string;
    }[]
  ).find(
    ({ argv: called }) =>
      called[0] === "export-desktop-application" &&
      !called.includes("--schema"),
  );
  const flag = exportCall?.argv.indexOf("--download-install") ?? -1;
  expect(flag).toBeGreaterThan(0);
  expect(
    JSON.parse(
      await readFile(
        resolve(exportCall?.cwd ?? "", exportCall?.argv[flag + 1] ?? ""),
        "utf8",
      ),
    ),
  ).toEqual({
    kind: "appimage",
    desktop_entry: "org.example.notes",
    ...download,
  });
  expect(argv("capture-desktop-application")).not.toContain("--package-file");
  expect(
    await readFile(join(directory, "envs/notes/notes_app.py"), "utf8"),
  ).toContain(
    `sha256="${"f".repeat(64)}", to="vendor/app.AppImage", arch="amd64")`,
  );
});

it("brings back a bundle whose file list outgrows a command's 1 MiB of output", async () => {
  const fakeSet = await fakes();
  const { outputs, client } = fakeSet;
  // 1,500 files whose list, about 1.15 MB with their long paths, is more than the 1 MiB exec answers with.
  const long = (letter: string) => letter.repeat(200);
  const extra = join(outputs.bundle, "seed", long("a"), long("b"));
  await mkdir(extra, { recursive: true });
  for (let index = 0; index < 1500; index += 1)
    await writeFile(join(extra, `${long("c")}-${String(index)}`), "x");
  const id = await startBuildComputer(client, BUILD_REQUEST);
  await captureSeedAndEnd(client, id);
  await callOk(client, "stop_build_capture", { computer_id: id });
  const directory = join(await createTestTempDirectory("build-out-"), "bundle");
  const exported = toolContract("export_build_environment").outputSchema.parse(
    (
      await callOk(client, "export_build_environment", {
        computer_id: id,
        tasks: [{ task: BUILD_TASK }],
        directory,
      })
    ).structuredContent,
  );
  expect(exported.files).toBeGreaterThan(1500);
  expect(
    await readdir(join(directory, "seed", long("a"), long("b"))),
  ).toHaveLength(1500);
});
