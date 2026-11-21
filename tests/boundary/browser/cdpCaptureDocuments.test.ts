import { expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { trackBrowser } from "./cdpBrowserProvider.support.js";

it("marks a missing resource frame tree incomplete through CDP", async () => {
  const browser = await startFakeCdpBrowser({
    commandResult: (command) =>
      command.method === "Page.getResourceTree" ? {} : undefined,
  });
  trackBrowser(browser);

  const result = await new CdpBrowserProvider().inspectPage(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 0,
    }),
  );

  if (!result.ok) throw result.error;
  expect(result.value.resources).toEqual([]);
  expect(result.value.completeness.unavailable_sections).toContain("resources");
});

const startAccessibilityCapture = async () => {
  const state = { reply: { nodes: [] } as Readonly<Record<string, unknown>> };
  const browser = await startFakeCdpBrowser({
    commandResult: (command) =>
      command.method === "Accessibility.getFullAXTree"
        ? state.reply
        : undefined,
  });
  trackBrowser(browser);
  const inspect = async (includeText?: boolean) => {
    const result = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 0,
        include_accessibility_text: includeText,
      }),
    );
    if (!result.ok) throw result.error;
    return result.value;
  };
  return { state, inspect };
};

it("distinguishes an empty accessibility inventory from an unreadable command reply", async () => {
  const { state, inspect } = await startAccessibilityCapture();
  const empty = await inspect(true);
  expect(empty.accessibility).toEqual({
    total_nodes: 0,
    nodes: [],
    text_capture: { status: "included", retained_bytes: 0, excluded_fields: 0 },
  });
  expect(empty.completeness.unavailable_sections).not.toContain(
    "accessibility",
  );
  expect(empty.completeness.truncated_sections).not.toContain("accessibility");
  expect(
    empty.completeness.excluded.filter(
      ({ section }) => section === "accessibility",
    ),
  ).toEqual([]);

  for (const [label, reply] of [
    ["omitted", {}],
    ["non-array", { nodes: { length: 1 } }],
  ] as const) {
    state.reply = reply;
    const unreadable = await inspect(true);
    expect(unreadable.accessibility, label).toMatchObject({
      total_nodes: 0,
      nodes: [],
    });
    expect(unreadable.completeness.unavailable_sections, label).toContain(
      "accessibility",
    );
    expect(
      unreadable.completeness.excluded.filter(
        ({ section }) => section === "accessibility",
      ),
      label,
    ).toEqual([
      {
        section: "accessibility",
        reason: "invalid_protocol_value",
        count: null,
      },
    ]);
    expect(unreadable.limitations, label).toContain(
      "Accessibility.getFullAXTree returned a malformed result; the section that reads it is incomplete.",
    );
    expect(unreadable.dom.total_nodes, label).toBeGreaterThan(0);
  }
});

it("retains admitted accessibility nodes and only reports unobserved usable child IDs", async () => {
  const { state, inspect } = await startAccessibilityCapture();
  const parent = {
    nodeId: "parent",
    ignored: false,
    parentId: "",
    childIds: ["", 3, "child"],
    role: { value: "button" },
    name: { value: "😀a" },
    description: { value: "éé" },
    properties: [
      { name: "disabled", value: { value: true } },
      { name: "valuetext", value: { value: "private value" } },
    ],
  };
  const siblings = [
    { nodeId: "child", ignored: false, parentId: "parent" },
    { nodeId: "invalid-parent", ignored: false, parentId: 3 },
    { nodeId: "invalid-children", ignored: false, childIds: "bad" },
    null,
    {},
    { nodeId: "missing-ignored" },
    { nodeId: "invalid-ignored", ignored: "false" },
    "malformed",
  ];
  state.reply = { nodes: [parent, ...siblings] };
  const approved = await inspect(true);
  const expectedNodes = [
    {
      node_id: "parent",
      parent_id: null,
      role: "button",
      ignored: false,
      states: [{ name: "disabled", value: true }],
    },
    { node_id: "child", parent_id: "parent", ignored: false },
    { node_id: "invalid-parent", parent_id: null, ignored: false },
    { node_id: "invalid-children", parent_id: null, ignored: false },
  ];
  expect(approved.accessibility).toMatchObject({
    total_nodes: 4,
    nodes: [
      { ...expectedNodes[0], name: "😀a", description: "éé" },
      ...expectedNodes.slice(1),
    ],
    text_capture: { status: "included", retained_bytes: 9, excluded_fields: 0 },
  });
  expect(approved.completeness.unavailable_sections).toContain("accessibility");
  expect(approved.completeness.truncated_sections).not.toContain(
    "accessibility",
  );
  expect(
    approved.completeness.excluded.filter(
      ({ section }) => section === "accessibility",
    ),
  ).toEqual([
    { section: "accessibility", reason: "invalid_protocol_value", count: 9 },
  ]);

  const unapproved = await inspect();
  expect(unapproved.accessibility).toMatchObject({
    total_nodes: 4,
    nodes: [
      { ...expectedNodes[0], name: null, description: null },
      ...expectedNodes.slice(1),
    ],
    text_capture: {
      status: "not_approved",
      retained_bytes: 0,
      excluded_fields: 2,
    },
  });
  expect(unapproved.completeness.truncated_sections).not.toContain(
    "accessibility",
  );
  expect(unapproved.completeness.excluded).toEqual(
    expect.arrayContaining([
      { section: "accessibility", reason: "invalid_protocol_value", count: 9 },
      { section: "accessibility", reason: "not_approved", count: 2 },
    ]),
  );

  state.reply = {
    nodes: [
      { ...parent, childIds: [...parent.childIds, "unobserved"] },
      ...siblings,
    ],
  };
  const withUnobservedChild = await inspect(true);
  expect(withUnobservedChild.accessibility).toEqual(approved.accessibility);
  expect(withUnobservedChild.completeness.truncated_sections).toContain(
    "accessibility",
  );
});
