import { expect, it } from "vitest";
import { signatureVerification } from "../../../../src/native/CodesignVerification.js";
import { NativeFixtureRunner } from "../../../fixtures/nativeCommands.js";

it.each(["permission denied", "I/O error", "EACCES"])(
  "does not classify echoed pathname %s as an I/O failure",
  async (text) => {
    const path = `/Applications/${text}.app`;
    const capture = await new NativeFixtureRunner().run("codesign", [
      "--verify",
      path,
    ]);
    if (!capture.ok) throw capture.error;
    const observed = signatureVerification(
      {
        ...capture.value,
        exitCode: 1,
        stderr: `${path}: a sealed resource is missing or invalid\n`,
      },
      path,
      false,
    );
    expect(observed.status).toBe("invalid");
    expect(observed.diagnostics).toEqual([
      `${path}: a sealed resource is missing or invalid`,
    ]);
  },
);

it("keeps operational, unsigned, definite invalid and unrecognized failures distinct", async () => {
  const path = "/Applications/Fixture.app";
  const capture = await new NativeFixtureRunner().run("codesign", [
    "--verify",
    path,
  ]);
  if (!capture.ok) throw capture.error;
  const status = (reason: string, unsigned = false) =>
    signatureVerification(
      { ...capture.value, exitCode: 1, stderr: `${path}: ${reason}\n` },
      path,
      unsigned,
    ).status;
  expect(status("permission denied")).toBe("unknown");
  expect(status("I/O error")).toBe("unknown");
  expect(status("invalid signature")).toBe("invalid");
  expect(status("bundle format unrecognized, invalid, or unsuitable")).toBe(
    "invalid",
  );
  expect(
    status(
      "resource fork, Finder information, or similar detritus not allowed",
    ),
  ).toBe("invalid");
  expect(status("code object is not signed at all", true)).toBe("unsigned");
  expect(status("code object is not signed at all")).toBe("invalid");
  expect(status("unrecognized failure")).toBe("unknown");
});

it("excludes complete selected paths with embedded newlines before classifying reasons", async () => {
  const path =
    "/Applications/permission denied\ncode object is not signed at all\nFixture.app";
  const capture = await new NativeFixtureRunner().run("codesign", [
    "--verify",
    path,
  ]);
  if (!capture.ok) throw capture.error;
  const result = signatureVerification(
    { ...capture.value, exitCode: 1, stderr: `${path}: invalid signature\n` },
    path,
    false,
  );
  expect(result.status).toBe("invalid");
  expect(result.diagnostics.join("\n")).toContain(path);
});

it("preserves definitive invalidity when other components have operational failures", async () => {
  const path = "/Applications/Fixture.app";
  const capture = await new NativeFixtureRunner().run("codesign", [
    "--verify",
    path,
  ]);
  if (!capture.ok) throw capture.error;
  const observed = signatureVerification(
    {
      ...capture.value,
      exitCode: 1,
      stderr: `${path}/Contents/Helpers/one: permission denied\n${path}/Contents/Helpers/two: invalid signature\n`,
    },
    path,
    false,
  );
  expect(observed.status).toBe("invalid");
  expect(observed.diagnostics).toHaveLength(2);
});

it("preserves unmatched prepared records and ignores unprefixed nested-name fragments as reasons", async () => {
  const path = "/Applications/Fixture.app";
  const capture = await new NativeFixtureRunner().run("codesign", [
    "--verify",
    path,
  ]);
  if (!capture.ok) throw capture.error;
  const stderr = `--prepared:${path}/Contents/Helpers/odd\ninvalid signature\n${path}: permission denied\n`;
  const result = signatureVerification(
    { ...capture.value, exitCode: 1, stderr },
    path,
    false,
  );
  expect(result.status).toBe("unknown");
  expect(result.prepared_nested_code).toEqual([`${path}/Contents/Helpers/odd`]);
  expect(result.raw_stderr).toBe(stderr);
  expect(result.diagnostics).toContain("invalid signature");
});
