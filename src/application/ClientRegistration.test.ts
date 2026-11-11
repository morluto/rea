import { expect, it } from "vitest";

import {
  parseClientRegistration,
  replaceClientRegistrationLauncher,
} from "./ClientRegistration.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import {
  parseClientConfiguration,
  clientConfigurationRecordSchema,
} from "./ClientConfigurationDocument.js";
import type { SetupClient } from "./SupportedClients.js";

const client: SetupClient = {
  name: "opencode",
  format: "opencode",
  configPath: "/fixture/opencode.json",
};

it("preserves every OpenCode environment key while normalizing its launcher", () => {
  const input = JSON.parse(
    '{"type":"local","command":["rea","mcp"],"environment":{"__proto__":"operator","constructor":"selected","normal":"value"}}',
  );
  const result = parseClientRegistration(input, client);
  if (!result.ok) throw result.error;
  expect(result.value.command).toBe("rea");
  expect(result.value.args).toEqual(["mcp"]);
  expect(result.value.environment).toEqual(input.environment);
  const environment = result.value.environment;
  if (typeof environment !== "object" || environment === null)
    throw new Error("Missing parsed environment");
  expect(Object.hasOwn(environment, "__proto__")).toBe(true);
});

it.each([42, null, {}])(
  "rejects malformed OpenCode environment values at __proto__: %j",
  (value) => {
    const environment = Object.fromEntries([["__proto__", value]]);
    const result = parseClientRegistration(
      { type: "local", command: ["rea", "mcp"], environment },
      client,
    );
    expect(result.ok).toBe(false);
  },
);

it("preserves Zed source metadata while replacing its native launcher", () => {
  const previous = {
    source: "operator-metadata",
    command: "old",
    args: ["old"],
    env: { KEEP: "1" },
    custom: { retained: true },
  };
  const updated = replaceClientRegistrationLauncher(
    "zed",
    ["fixture", ""],
    previous,
  );
  if (!updated.ok) throw updated.error;
  expect(updated.value).toEqual({
    ...previous,
    command: "fixture",
    args: [""],
  });
  const fresh = replaceClientRegistrationLauncher(
    "zed",
    ["fixture"],
    undefined,
  );
  if (!fresh.ok) throw fresh.error;
  expect(fresh.value).not.toHaveProperty("source");
});

it("normalizes Goose's single env alias without emitting duplicate native fields", () => {
  const env = JSON.parse(
    '{"KEEP":"1","__proto__":"selected","constructor":"owned"}',
  );
  const previous = {
    cmd: "old",
    args: [],
    env,
    enabled: false,
    custom: { retained: true },
  };
  const before = structuredClone(previous);
  const result = replaceClientRegistrationLauncher(
    "goose",
    ["fixture", ""],
    previous,
  );
  if (!result.ok) throw result.error;
  expect(result.value.envs).toEqual(env);
  expect(result.value).not.toHaveProperty("env");
  const canonical = clientConfigurationRecordSchema.parse(result.value.envs);
  expect(Object.hasOwn(canonical, "__proto__")).toBe(true);
  expect(result.value).toMatchObject({
    enabled: false,
    custom: { retained: true },
  });
  expect(previous).toEqual(before);
});

it.each([{ envs: { KEEP: "1" } }, {}])(
  "keeps canonical Goose environment data stable: %j",
  (previous) => {
    const result = replaceClientRegistrationLauncher(
      "goose",
      ["fixture"],
      previous,
    );
    if (!result.ok) throw result.error;
    expect(result.value.envs).toEqual("envs" in previous ? previous.envs : {});
    expect(result.value).not.toHaveProperty("env");
  },
);

it("keeps a native Goose leading-zero string when normalizing the env alias", () => {
  const parsed = parseClientConfiguration(
    "extensions:\n  rea:\n    cmd: old\n    env:\n      VALUE: 0123\n",
    "goose",
  );
  const result = replaceClientRegistrationLauncher(
    "goose",
    ["fixture"],
    parsed.servers.rea,
  );
  if (!result.ok) throw result.error;
  expect(result.value.envs).toEqual({ VALUE: "0123" });
  expect(result.value).not.toHaveProperty("env");
});

it("normalizes an explicitly empty Goose env alias to one canonical field", () => {
  const result = replaceClientRegistrationLauncher("goose", ["fixture"], {
    env: {},
  });
  if (!result.ok) throw result.error;
  expect(result.value.envs).toEqual({});
  expect(result.value).not.toHaveProperty("env");
});

it.each([
  { env: { KEEP: "1" }, envs: { KEEP: "1" } },
  { env: { KEEP: "old" }, envs: { KEEP: "new" } },
])(
  "refuses both Goose environment aliases even when their contents agree: %j",
  (previous) => {
    const result = replaceClientRegistrationLauncher(
      "goose",
      ["fixture"],
      previous,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Ambiguous Goose aliases were admitted");
    expect(result.error).toBeInstanceOf(ConfigurationError);
    expect(result.error.message).toContain("envs or its env alias, not both");
    expect(result.error.settings).toEqual([
      {
        setting: "envs",
        constraint: "env and envs declare the same native field",
      },
    ]);
  },
);

it.each([null, 42, ["value"], { VALUE: 123 }])(
  "refuses a malformed Goose env alias: %j",
  (env) => {
    const result = replaceClientRegistrationLauncher("goose", ["fixture"], {
      env,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Malformed Goose alias was admitted");
    expect(result.error).toBeInstanceOf(ConfigurationError);
    expect(result.error.settings).toEqual([
      {
        setting: "env",
        constraint: "Expected a mapping of string environment values",
      },
    ]);
  },
);

it("keeps other clients' env field in its own dialect", () => {
  const previous = { env: { KEEP: "1" }, command: "old" };
  const result = replaceClientRegistrationLauncher(
    "json",
    ["fixture"],
    previous,
  );
  if (!result.ok) throw result.error;
  expect(result.value.env).toEqual({ KEEP: "1" });
  expect(result.value).not.toHaveProperty("envs");
});
