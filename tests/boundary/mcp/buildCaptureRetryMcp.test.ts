import { join } from "node:path";

import type { Client } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  BUILD_REQUEST,
  BUILD_TASK,
  buildCaptureFakes as fakes,
} from "../../fixtures/buildCaptureFakes.js";
import { callOk, startBuildComputer } from "../../fixtures/buildComputerMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const call = (client: Client, name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args });

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
  const { rea, client } = await fakes({ dropReplies: ["run"] });
  const id = await startBuildComputer(client, BUILD_REQUEST);
  await callOk(client, "start_build_capture", { computer_id: id });
  for (const name of ["seed", "end"])
    await callOk(client, "mark_build_checkpoint", { computer_id: id, name });
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
    task: BUILD_TASK,
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

it("captures and exports an app installed from a .deb file with the file and its URL", async () => {
  const { rea, client } = await fakes();
  const url = "https://downloads.example.com/notes_1.0_amd64.deb";
  const id = await startBuildComputer(client, {
    kind: "request",
    desktop_entry: "org.example.notes",
    install: {
      kind: "package_file",
      url,
      sha256: "0".repeat(64),
      architecture: "amd64",
      dependencies: [],
    },
  });
  await callOk(client, "start_build_capture", { computer_id: id });
  for (const name of ["seed", "end"])
    await callOk(client, "mark_build_checkpoint", { computer_id: id, name });
  await callOk(client, "stop_build_capture", { computer_id: id });
  await callOk(client, "export_build_environment", {
    computer_id: id,
    task: BUILD_TASK,
    directory: join(await createTestTempDirectory("build-out-"), "bundle"),
  });
  const calls = ((await rea.notes("calls.jsonl")) as { argv: string[] }[]).map(
    ({ argv }) => argv,
  );
  const argv = (command: string) =>
    calls.find((candidate) => candidate[0] === command) ?? [];
  expect(argv("capture-desktop-application")).toEqual(
    expect.arrayContaining(["--package-file", "/opt/rea/package.deb"]),
  );
  expect(argv("export-desktop-application")).toEqual(
    expect.arrayContaining(["--package-url", url]),
  );
});
