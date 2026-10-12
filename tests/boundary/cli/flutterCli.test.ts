import { expect, it } from "vitest";

import { serveCli } from "./cliServeHarness.js";

it.each(["identify-flutter-build", "inspect-dart-aot"])(
  "%s advertises a schema through the public CLI",
  async (command) => {
    const result = await serveCli([command, "--schema", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toBeTruthy();
  },
);

it("reports an unreadable target with an input refusal", async () => {
  const result = await serveCli([
    "identify-flutter-build",
    "/nonexistent/app.apk",
    "--json",
  ]);
  expect(result.stdout).toContain("invalid_request");
});
