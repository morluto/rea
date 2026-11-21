import { describe, expect, it } from "vitest";

import { passiveNetworkCapture } from "../../tests/fixtures/passiveNetworkCapture.js";
import {
  browserCaptureComparisonInputSchema,
  compareBrowserCaptures,
} from "./browserCaptureComparison.js";
import type { WebPageInspection } from "./browserObservationSchemas.js";
import { webCaptureDiffSchema } from "./webCaptureDiffSchemas.js";
import { stableWebResources } from "./webInventory.js";

const resource = (
  content_size: number | null,
  url = "https://app.example.test/app.css",
) => ({
  url,
  origin: "https://app.example.test",
  type: "Stylesheet",
  mime_type: "text/css",
  content_size,
});

const capture = (resources: readonly ReturnType<typeof resource>[]) => {
  const inspection: WebPageInspection = passiveNetworkCapture();
  inspection.resources = stableWebResources(resources);
  return inspection;
};

const compareResources = (
  before: WebPageInspection,
  after: WebPageInspection,
) =>
  webCaptureDiffSchema.parse(
    compareBrowserCaptures(
      browserCaptureComparisonInputSchema.parse({
        before: { inspection: before },
        after: { inspection: after },
      }),
    ),
  ).dimensions.resources;

describe("web resource comparison identity and optional size", () => {
  it.each([
    [[128], [null]],
    [[128, 256], [null]],
    [
      [128, 256],
      [128, null],
    ],
  ])("does not infer membership from unknown size: %j vs %j", (left, right) => {
    expect(
      compareResources(
        capture(left.map((size) => resource(size))),
        capture(right.map((size) => resource(size))),
      ),
    ).toMatchObject({ status: "unknown", total_changes: 0, changes: [] });
  });

  it("compares distinct all-known size variants and keeps exact deduplication", () => {
    const before = stableWebResources([resource(128), resource(256)]);
    const after = stableWebResources([resource(128), resource(512)]);
    expect(before).toHaveLength(2);
    expect(after).toHaveLength(2);
    expect(before.map(({ resource_key }) => resource_key)).not.toEqual(
      after.map(({ resource_key }) => resource_key),
    );
    expect(
      compareResources(
        capture([resource(128), resource(256)]),
        capture([resource(128), resource(512)]),
      ),
    ).toMatchObject({
      status: "changed",
      total_changes: 1,
      changes: [{ change: "modified" }],
    });
    expect(stableWebResources([resource(128), resource(128)])).toHaveLength(1);
    expect(
      compareResources(
        capture([resource(128), resource(128)]),
        capture([resource(128)]),
      ),
    ).toMatchObject({
      status: "unchanged",
      total_changes: 0,
      changes: [],
    });
  });

  it("retains complete group removal and distinct known identities", () => {
    expect(
      compareResources(capture([resource(128)]), capture([])),
    ).toMatchObject({
      status: "changed",
      total_changes: 1,
      changes: [{ change: "removed" }],
    });
    expect(
      compareResources(
        capture([resource(128)]),
        capture([resource(128, "https://app.example.test/other.css")]),
      ),
    ).toMatchObject({
      status: "changed",
      total_changes: 2,
      changes: expect.arrayContaining([
        expect.objectContaining({ change: "removed" }),
        expect.objectContaining({ change: "added" }),
      ]),
    });
  });
});

it("does not claim membership from an unavailable resource inventory", () => {
  const before = capture([resource(128)]);
  const after = capture([
    resource(128),
    resource(256, "https://app.example.test/child.css"),
  ]);
  after.completeness.unavailable_sections.push("resources");
  for (const [left, right] of [
    [before, after],
    [after, before],
    [after, after],
  ] as const)
    expect(compareResources(left, right)).toMatchObject({
      status: "unknown",
      total_changes: 0,
      changes: [],
      reason: expect.stringContaining("Resource inventory"),
    });
});

it.each([
  [[128, 256], [128], [false, true], "unknown"],
  [[128], [256], [true, true], "unknown"],
  [[128], [128], [true, true], "unknown"],
  [[128], [128, 256], [false, true], "changed"],
  [[], [128], [false, true], "changed"],
  [[128], [], [true, true], "unknown"],
  [[128], [null], [false, true], "unknown"],
] as const)(
  "uses directional resource coverage for %j vs %j (limited=%j): %s",
  (leftSizes, rightSizes, [leftLimited, rightLimited], status) => {
    const before = capture(leftSizes.map((size) => resource(size)));
    const after = capture(rightSizes.map((size) => resource(size)));
    if (leftLimited) before.completeness.truncated_sections.push("resources");
    if (rightLimited) after.completeness.truncated_sections.push("resources");
    for (const [left, right] of [
      [before, after],
      [after, before],
    ] as const)
      expect(compareResources(left, right)).toMatchObject({
        status,
        total_changes: status === "changed" ? 1 : 0,
        changes:
          status === "changed"
            ? [
                {
                  identity: expect.stringMatching(/^resg_/u),
                  change:
                    left.resources.length === 0
                      ? "added"
                      : right.resources.length === 0
                        ? "removed"
                        : "modified",
                },
              ]
            : [],
        reason:
          status === "changed"
            ? null
            : expect.stringContaining("Resource inventory"),
      });
  },
);
