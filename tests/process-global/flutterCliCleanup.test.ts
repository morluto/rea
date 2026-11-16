import { Cli } from "incur";
import { expect, it, onTestFinished, vi } from "vitest";
import { registerFlutterCommands } from "../../src/cli/flutterCommands.js";
import { aotFixtureImage } from "../../src/flutter/FlutterBuild.fixture.js";
import { FlutterBuildProvider } from "../../src/flutter/FlutterBuildProvider.js";
import { silentLogger } from "../../src/logger.js";
import {
  interceptFlutterRootRemoval,
  realRm,
} from "../fixtures/flutterCleanup.js";
import { createFlutterApk } from "../fixtures/flutterApk.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original };
});

/** Serve one command whose first snapshot-root removal fails and is retried on close. */
const serveWithCleanupRetry = async (
  command: string,
  apk: string,
  interrupt: boolean,
  retryFails = false,
): Promise<Record<string, unknown>> => {
  const inherited = new Set(process.listeners("SIGINT"));
  const roots: string[] = [];
  interceptFlutterRootRemoval(async (root) => {
    roots.push(root);
    if (roots.length > 2) return realRm(root, { recursive: true, force: true });
    // Deliver SIGINT to the command's own listener during the retry.
    if (roots.length === 2 && interrupt)
      for (const listener of process.listeners("SIGINT"))
        if (!inherited.has(listener)) listener("SIGINT");
    if (roots.length === 1 || retryFails)
      throw Object.assign(new Error("transient snapshot removal refusal"), {
        code: "EACCES",
      });
    await realRm(root, { recursive: true, force: true });
  });
  const provider = new FlutterBuildProvider();
  onTestFinished(() => provider.close());
  const cli = Cli.create("flutter-cleanup-retry-test", { sync: false });
  registerFlutterCommands(cli, silentLogger, provider);
  let stdout = "";
  await cli.serve([command, apk, "--format", "json"], {
    stdout: (text) => {
      stdout += text;
    },
    exit: () => {},
  });
  expect(roots).toEqual([roots[0], roots[0]]);
  return JSON.parse(stdout) as Record<string, unknown>;
};

it.each([
  ["identify-flutter-build", "identify_flutter_build"],
  ["inspect-dart-aot", "inspect_dart_aot"],
] as const)(
  "%s reports SIGINT during the cleanup retry as cancellation with completed facts",
  async (command, operation) => {
    const apk = await createFlutterApk("cleanup-retry.apk", [
      { path: "lib/arm64-v8a/libapp.so", bytes: aotFixtureImage() },
    ]);
    const exitCode = process.exitCode;
    onTestFinished(() => {
      process.exitCode = exitCode;
    });
    const control = await serveWithCleanupRetry(command, apk, false);
    expect(control).toMatchObject({
      operation,
      confidence: "observed",
      caller_input_path: apk,
    });
    expect(process.exitCode).toBe(exitCode);
    const interrupted = await serveWithCleanupRetry(command, apk, true);
    expect(process.exitCode).toBe(130);
    expect(interrupted).toMatchObject({
      code: "cancelled",
      details: {
        operation,
        partial_observation: {
          operation,
          caller_input_path: apk,
          subject: { local_path: apk },
          confidence: "observed",
          normalized_result: control.normalized_result,
        },
      },
    });
    const incomplete = await serveWithCleanupRetry(command, apk, true, true);
    expect(incomplete).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        resources: [expect.stringContaining("rea-flutter-")],
        partial_observation: {
          operation,
          caller_input_path: apk,
          normalized_result: control.normalized_result,
        },
      },
    });
  },
);
