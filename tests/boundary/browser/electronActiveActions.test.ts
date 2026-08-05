import { expect, it } from "vitest";

import { electronActiveObservationInputSchema } from "../../../src/domain/electronActiveObservation.js";

it("parses bounded window, renderer, and deep-link actions for agents", () => {
  const input = electronActiveObservationInputSchema.parse({
    schema_version: 1,
    executable_path: "/opt/electron",
    application_path: "/opt/app/main.js",
    application_root: "/opt/app",
    actions: [
      { step_id: "first-window", kind: "click", selector: "#run" },
      { step_id: "second-window", kind: "renderer-reload", window_index: 1 },
      { step_id: "restart", kind: "renderer-crash", window_index: 1 },
      {
        step_id: "deep-link",
        kind: "deep-link",
        delivery: "second-instance",
        url: "rea-fixture://open/item",
      },
    ],
    approved: true,
  });

  expect(input.actions).toEqual([
    {
      step_id: "first-window",
      kind: "click",
      selector: "#run",
      window_index: 0,
    },
    { step_id: "second-window", kind: "renderer-reload", window_index: 1 },
    { step_id: "restart", kind: "renderer-crash", window_index: 1 },
    {
      step_id: "deep-link",
      kind: "deep-link",
      delivery: "second-instance",
      url: "rea-fixture://open/item",
    },
  ]);
});

it("rejects non-absolute deep-link values", () => {
  const result = electronActiveObservationInputSchema.safeParse({
    schema_version: 1,
    executable_path: "/opt/electron",
    application_path: "/opt/app/main.js",
    application_root: "/opt/app",
    actions: [
      {
        step_id: "bad-link",
        kind: "deep-link",
        delivery: "open-url",
        url: "not a URL",
      },
    ],
    approved: true,
  });

  expect(result.success).toBe(false);
});
