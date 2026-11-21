import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { buildNativeAotFixture } from "../../../scripts/lib/nativeaot-build.mjs";

const options = {
  dotnet: "fixture-dotnet",
  project: "fixture.csproj",
  runtime: "win-x64",
  output: "fixture-output",
};
type Run = Parameters<typeof buildNativeAotFixture>[0];

it("retries the publish target's restore without logging credentials and publishes without restoring again", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const timeout = Object.assign(
    new Error(
      "dotnet restore ETIMEDOUT https://fixture-user:fixture-password@feed.invalid/v3/index.json",
    ),
    { code: "ETIMEDOUT" },
  );
  const run = vi.fn<Run>().mockImplementationOnce(() => {
    throw timeout;
  });
  try {
    await buildNativeAotFixture(run, options);
    const output = logged.mock.calls.flat();
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("attempt 2/2"));
    expect(output.every((value) => typeof value === "string")).toBe(true);
    expect(output.join("\n")).not.toMatch(/fixture-(?:user|password)/u);
  } finally {
    logged.mockRestore();
  }
  expect(
    run.mock.calls.map(([command, [operation]]) => [command, operation]),
  ).toEqual([
    [options.dotnet, "restore"],
    [options.dotnet, "restore"],
    [options.dotnet, "publish"],
  ]);
  const [restore, retry, publish] = run.mock.calls.map(([, args]) => args);
  const target = [
    options.project,
    options.runtime,
    "-p:Configuration=Release",
    `-p:BaseIntermediateOutputPath=${join(options.output, "obj")}/`,
  ];
  expect(restore).toEqual(expect.arrayContaining(target));
  expect(retry).toEqual(restore);
  expect(publish).toEqual(expect.arrayContaining([...target, "--no-restore"]));
});

it("stops after two restore failures and preserves the final diagnostic", async () => {
  const failure = new Error("NuGet source unavailable");
  const run = vi
    .fn<Run>(() => {
      throw failure;
    })
    .mockImplementationOnce(() => {
      throw new Error("Initial restore timeout");
    });
  await expect(buildNativeAotFixture(run, options)).rejects.toMatchObject({
    message: "NativeAOT dependency restore failed after two attempts",
    cause: failure,
  });
  expect(run.mock.calls.map(([, [operation]]) => operation)).toEqual([
    "restore",
    "restore",
  ]);
});

it("does not retry compilation failures", async () => {
  const failure = new Error("Native compiler rejected the fixture");
  const run = vi
    .fn<Run>()
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      throw failure;
    });
  await expect(buildNativeAotFixture(run, options)).rejects.toBe(failure);
  expect(run.mock.calls.map(([, [operation]]) => operation)).toEqual([
    "restore",
    "publish",
  ]);
});
