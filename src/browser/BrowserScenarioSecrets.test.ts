import { expect, it } from "vitest";
import { browserScenarioSchema } from "../domain/browserScenario.js";
import { BrowserScenarioSecrets } from "./BrowserScenarioSecrets.js";
import { readResponseValues } from "./BrowserScenarioResponseValues.js";

const scenario = browserScenarioSchema.parse({
  browser: { mode: "launch", executable_path: "/fixture/chrome" },
  start_url: { url: "https://example.test/" },
  actions: [
    {
      step_id: "save",
      action: "request",
      method: "GET",
      path: "/value",
      save: [{ name: "token", json_pointer: "/token", secret: true }],
    },
  ],
});

it.each([
  'private-\ud800-"\\token',
  'private-\udc00-"\\token',
  'private-\ud83d\ude80-"\\token',
])(
  "retains exact saved values and redacts their JSON, UTF-8 and URL representations: %j",
  (token) => {
    const resolved = BrowserScenarioSecrets.resolve(scenario, {});
    if (!resolved.ok) throw resolved.error;
    const secrets = resolved.value;
    const action = scenario.actions[0]!;
    if (action.action !== "request") throw new Error("Expected request");
    const body = JSON.stringify({ token, other: "visible" });
    const selected = readResponseValues(Buffer.from(body), action.save, "fail");
    if (!selected.ok) throw new Error(selected.error.message);
    expect(selected.value.values[0]!.value).toBe(token);
    for (const { entry, value } of selected.value.values)
      secrets.save("save", entry.name, value, entry.secret);
    expect(secrets.savedValue("token")).toBe(token);
    const scalar = new TextDecoder().decode(new TextEncoder().encode(token));
    for (const value of [token, scalar]) {
      expect(secrets.redact(value)).not.toBe(value);
      expect(secrets.redact(JSON.stringify(value))).not.toBe(
        JSON.stringify(value),
      );
      expect(secrets.fingerprint(value)).toEqual({
        value_state: "redacted-secret",
        value_sha256: null,
      });
    }
    const rawBytes = Buffer.from(token);
    expect(secrets.redactBytes(rawBytes).equals(rawBytes)).toBe(false);
    const destination = new URL("https://example.test/");
    destination.searchParams.set("value", token);
    expect(secrets.sanitizeUrl(destination.href)).toMatchObject({
      redacted: true,
    });
    expect(secrets.sanitizeUrl(destination.href).url).not.toBe(
      destination.href,
    );
    const request = {};
    secrets.responseProtector("save", action.save)!(request);
    const protectedBody = secrets.admitResponseSecrets(
      request,
      Buffer.from(body),
      { maxBytes: 4096, maxAllocationBytes: 65536 },
    );
    expect(JSON.parse(protectedBody.toString())).toMatchObject({
      other: "visible",
    });
    expect(JSON.parse(protectedBody.toString()).token).not.toBe(token);
    expect(secrets.redact("unrelated value")).toBe("unrelated value");
  },
);
