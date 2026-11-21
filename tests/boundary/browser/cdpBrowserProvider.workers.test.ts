import { expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { trackBrowser } from "./cdpBrowserProvider.support.js";

const capture = async (
  inventory: (origin: string) => Readonly<Record<string, unknown>>,
) => {
  const browser = await startFakeCdpBrowser({
    commandResult: (command, origin) =>
      command.method === "Target.getTargets" ? inventory(origin) : undefined,
  });
  trackBrowser(browser);
  const result = await new CdpBrowserProvider().inspectPage(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      target_id: "allowed-page",
      allowed_origins: [browser.allowedOrigin],
      observation_ms: 0,
    }),
  );
  if (!result.ok) throw result.error;
  return {
    origin: browser.allowedOrigin,
    workers: result.value.workers,
    completeness: result.value.completeness,
  };
};

const worker = (targetId: string, url: string) => ({
  targetId,
  type: "worker",
  url,
  attached: false,
});

it("projects scoped worker relationships and classifies malformed and denied siblings", async () => {
  const malformedFields = [
    { type: undefined },
    { type: 7 },
    { type: "" },
    { targetId: undefined },
    { targetId: "" },
    { url: undefined },
    { attached: "true" },
    { attached: null },
    { openerId: "" },
    { openerId: null },
    { parentFrameId: null },
    { parentFrameId: "" },
  ];
  const { origin, workers, completeness } = await capture((origin) => ({
    targetInfos: [
      { type: "page", targetId: 7, openerId: null },
      null,
      {
        ...worker("by-opener", `${origin}/opener.js`),
        type: "service_worker",
        attached: true,
        openerId: "allowed-page",
      },
      ...malformedFields.map((fields, index) => ({
        ...worker(
          `malformed-${String(index)}`,
          "https://outside.example/worker.js",
        ),
        openerId: "other-page",
        ...fields,
      })),
      {
        ...worker("by-frame", `${origin}/frame.js`),
        type: "shared_worker",
        openerId: "other-page",
        parentFrameId: "frame-main",
      },
      {
        ...worker("foreign-opener", `${origin}/foreign-opener.js`),
        attached: true,
        openerId: "other-page",
      },
      {
        ...worker("foreign", `${origin}/foreign.js`),
        attached: true,
        parentFrameId: "other-frame",
      },
      { ...worker("empty-url", ""), openerId: "allowed-page" },
      {
        ...worker("foreign-origin", "https://outside.example/worker.js"),
        openerId: "allowed-page",
      },
      {
        ...worker("unsupported-url", "file:///fixture/worker.js"),
        openerId: "allowed-page",
      },
      "malformed",
    ],
  }));
  expect(workers).toHaveLength(2);
  expect(workers).toEqual(
    expect.arrayContaining([
      {
        target_id: "by-opener",
        type: "service_worker",
        url: `${origin}/opener.js`,
        origin,
        attached: true,
        opener_target_id: "allowed-page",
        parent_frame_id: null,
      },
      {
        target_id: "by-frame",
        type: "shared_worker",
        url: `${origin}/frame.js`,
        origin,
        attached: false,
        opener_target_id: "other-page",
        parent_frame_id: "frame-main",
      },
    ]),
  );
  const excluded = completeness.excluded.filter(
    ({ section }) => section === "workers",
  );
  expect(excluded).toHaveLength(5);
  expect(excluded).toEqual(
    expect.arrayContaining([
      {
        section: "workers",
        reason: "invalid_protocol_value",
        count: malformedFields.length + 2,
      },
      { section: "workers", reason: "out_of_target_scope", count: 2 },
      { section: "workers", reason: "unattributed_origin", count: 1 },
      { section: "workers", reason: "disallowed_origin", count: 1 },
      { section: "workers", reason: "unsupported_url", count: 1 },
    ]),
  );
  expect(completeness.attach_limited_sections).toContain("workers");
  expect(completeness.unavailable_sections).toContain("workers");
  expect(completeness.policy_filtered_sections).toContain("workers");
});

it("reports unattributed workers independently of attachment and origin", async () => {
  const { workers, completeness } = await capture((origin) => ({
    targetInfos: [
      {
        ...worker("unknown-origin-known", `${origin}/worker.js`),
        attached: true,
      },
      worker("unknown-origin-empty", ""),
    ],
  }));
  expect(workers).toEqual([]);
  expect(completeness.policy_filtered_sections).not.toContain("workers");
  expect(completeness.attach_limited_sections).toContain("workers");
  expect(completeness.unavailable_sections).toContain("workers");
  expect(
    completeness.excluded.filter(({ section }) => section === "workers"),
  ).toEqual([{ section: "workers", reason: "unattributed_target", count: 2 }]);
});

it.each([
  { label: "empty", envelope: { targetInfos: [] }, unavailable: false },
  { label: "missing", envelope: {}, unavailable: true },
  {
    label: "non-array",
    envelope: { targetInfos: { length: 1 } },
    unavailable: true,
  },
])(
  "distinguishes the $label worker inventory on the wire",
  async ({ envelope, unavailable }) => {
    const { workers, completeness } = await capture(() => envelope);
    expect(workers).toEqual([]);
    expect(completeness.attach_limited_sections).toContain("workers");
    expect(completeness.unavailable_sections.includes("workers")).toBe(
      unavailable,
    );
    const invalidInventory = {
      section: "workers",
      reason: "invalid_protocol_value",
      count: null,
    };
    expect(
      completeness.excluded.filter(({ section }) => section === "workers"),
    ).toEqual(unavailable ? [invalidInventory] : []);
  },
);
