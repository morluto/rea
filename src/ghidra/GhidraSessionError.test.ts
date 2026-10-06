import { describe, expect, it } from "vitest";

import { bindGhidraSessionFailure } from "./GhidraSessionError.js";

const diagnostics = {
  target_path: "/tmp/public-fixture",
  target_sha256: "a".repeat(64),
};

describe("Ghidra session failure diagnostics", () => {
  it("retains the original Error while projecting its name, message and code", () => {
    const cause = Object.assign(
      new TypeError("Cannot decode /tmp/public-fixture at offset 17"),
      { code: "EDECODE" },
    );
    const failure = bindGhidraSessionFailure(() => diagnostics)(
      "protocol",
      "Request rejected",
      cause,
    );
    expect(failure.cause).toBe(cause);
    expect(failure.kind).toBe("protocol");
    expect(failure.diagnostics).toEqual({
      ...diagnostics,
      failure_cause: {
        name: "TypeError",
        message: cause.message,
        code: "EDECODE",
      },
    });
    expect(failure.diagnostics).not.toHaveProperty("stack");
  });

  it.each([
    ["decoder rejected", { type: "string", message: "decoder rejected" }],
    [null, { type: "null", value: null }],
    [false, { type: "boolean", value: false }],
    [42, { type: "number", value: 42 }],
    [{ opaque: true }, { type: "object" }],
  ])("handles a non-Error rejection (%j)", (cause, expected) => {
    const failure = bindGhidraSessionFailure(() => diagnostics)(
      "process",
      "Shutdown rejected",
      cause,
    );
    expect(failure.cause).toBe(cause);
    expect(failure.diagnostics.failure_cause).toEqual(expected);
  });

  it("redacts only known authentication material in projected failure fields", () => {
    const token = "actual-bridge-authentication";
    const message = `Failure ${token}: http://localhost/secret?token=public-value /tmp/password-fixture`;
    const cause = Object.assign(new Error(message), { code: `code-${token}` });
    const failure = bindGhidraSessionFailure(
      () => diagnostics,
      (value) => value.replaceAll(token, "[REDACTED]"),
    )("remote", message, cause, { remoteCode: `code-${token}` });
    expect(failure.cause).toBe(cause);
    expect(failure.message).toBe(message.replaceAll(token, "[REDACTED]"));
    expect(failure.diagnostics).toMatchObject({
      remote_code: "code-[REDACTED]",
      remote_message: failure.message,
      failure_cause: { message: failure.message, code: "code-[REDACTED]" },
    });
    expect(JSON.stringify(failure.diagnostics)).not.toContain(token);
    expect(JSON.stringify(failure.diagnostics)).toContain(
      "token=public-value /tmp/password-fixture",
    );
  });

  it("leaves absent causes and existing timeout metadata unchanged", () => {
    const failure = bindGhidraSessionFailure(() => diagnostics)(
      "timeout",
      "Deadline elapsed",
      undefined,
      { timeoutMs: 5 },
    );
    expect(failure.timeoutMs).toBe(5);
    expect(failure.diagnostics).toEqual(diagnostics);
  });
});
