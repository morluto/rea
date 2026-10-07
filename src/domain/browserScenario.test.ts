import { expect, it } from "vitest";

import { browserScenarioSchema } from "./browserScenario.js";

it("accepts large action, secret, and storage selections", () => {
  const actions = Array.from({ length: 129 }, (_, index) => ({
    step_id: `fill_${index}`,
    action: "fill",
    locator: { kind: "css", selector: "#field" },
    value: { source: "secret", secret_id: `secret_${index}` },
  }));
  const secrets = Array.from({ length: actions.length }, (_, index) => ({
    secret_id: `secret_${index}`,
    environment_variable: `SECRET_${index}`,
  }));
  const cookies = Array.from({ length: 129 }, (_, index) => ({
    name: `cookie_${index}`,
    value: { source: "literal", value: "value" },
    destination: { url: "https://app.example.test/" },
    http_only: false,
    secure: true,
    same_site: "Lax",
  }));
  const storageEntries = Array.from({ length: 129 }, (_, index) => ({
    name: `entry_${index}`,
    value: { source: "literal", value: "value" },
  }));

  const result = browserScenarioSchema.parse({
    browser: {
      mode: "launch",
      executable_path: "/opt/chromium",
    },
    start_url: { url: "https://app.example.test/" },
    actions,
    secrets,
    storage: {
      cookies,
      local_storage: [
        { origin: "https://app.example.test", entries: storageEntries },
      ],
      session_storage: [
        { origin: "https://app.example.test", entries: storageEntries },
      ],
    },
  });

  expect(result.actions).toHaveLength(129);
  expect(result.secrets).toHaveLength(129);
  expect(result.storage.cookies).toHaveLength(129);
  expect(result.storage.local_storage[0]?.entries).toHaveLength(129);
  expect(result.storage.session_storage[0]?.entries).toHaveLength(129);
});

it("does not require duplicate origin scope declarations", () => {
  const scenario = browserScenarioSchema.parse({
    browser: {
      mode: "launch",
      executable_path: "/opt/chromium/chrome",
    },
    start_url: { url: "https://app.example.test/" },
    actions: [
      {
        step_id: "navigate",
        action: "goto",
        destination: { url: "https://other.example.test/" },
        wait_until: "load",
      },
    ],
    storage: {
      local_storage: [
        {
          origin: "https://storage.example.test",
          entries: [
            { name: "theme", value: { source: "literal", value: "dark" } },
          ],
        },
      ],
    },
  });

  expect(scenario.actions[0]).toMatchObject({
    destination: { url: "https://other.example.test/" },
  });
  expect(scenario.storage.local_storage[0]?.origin).toBe(
    "https://storage.example.test",
  );
});

it("accepts complete browser inputs beyond former string length caps", () => {
  const longValue = "value".repeat(20_000);
  const longToken = "a".repeat(70_000);
  const longEnvironmentVariable = "SECRET_A".repeat(10_000);
  const longPath = `/app/${"segment".repeat(3_000)}`;
  const result = browserScenarioSchema.parse({
    browser: {
      mode: "launch",
      executable_path: longPath,
    },
    start_url: { url: `https://app.example.test${longPath}` },
    secrets: [
      {
        secret_id: longToken,
        environment_variable: longEnvironmentVariable,
      },
    ],
    actions: [
      {
        step_id: longToken,
        action: "fill",
        locator: { kind: "css", selector: `#${longValue}` },
        value: { source: "secret", secret_id: longToken },
      },
    ],
    storage: {
      cookies: [
        {
          name: longToken,
          value: {
            source: "literal",
            value: longValue,
          },
          destination: { url: "https://app.example.test/" },
          http_only: false,
          secure: true,
          same_site: "Lax",
        },
      ],
    },
  });

  expect(result.actions[0]?.step_id).toBe(longToken);
  expect(
    result.actions[0]?.action === "fill" &&
      result.actions[0].value.source === "secret"
      ? result.actions[0].value.secret_id
      : undefined,
  ).toBe(longToken);
  expect(result.storage.cookies[0]?.name).toBe(longToken);
  expect(result.secrets[0]?.environment_variable).toBe(longEnvironmentVariable);
});

it("accepts caller-selected viewport sizes and click counts without ceilings", () => {
  const input = {
    browser: {
      mode: "launch",
      executable_path: "/opt/chromium",
    },
    start_url: { url: "https://app.example.test/" },
    environment: {
      viewport: { width: 20_000, height: 10_000, device_scale_factor: 8 },
    },
    actions: [
      {
        step_id: "many-clicks",
        action: "click",
        locator: { kind: "css", selector: "#item" },
        click_count: 4,
      },
    ],
  };

  const parsed = browserScenarioSchema.parse(input);
  expect(parsed.environment.viewport).toEqual({
    width: 20_000,
    height: 10_000,
    device_scale_factor: 8,
  });
  expect(parsed.actions[0]).toMatchObject({ click_count: 4 });
});
