import { describe, expect, it } from "vitest";

import {
  timedCaptureEvidence,
  type TimedCaptureRow,
} from "../../../tests/fixtures/analysisView.js";
import {
  environmentServeSource,
  environmentStateServeFixture,
} from "../../../tests/fixtures/environmentServe.js";
import {
  BOOK_INIT_ROWS,
  BOOK_NOT_FOUND,
  BOOK_ROWS,
  FIRST_BOOK,
  SECOND_BOOK,
} from "../../../tests/fixtures/environmentStateWrites.js";
import { compareEnvironment } from "./environmentCompare.js";
import {
  scenarioCaptureEvidence,
  scenarioCaptureFixture,
} from "../../../tests/fixtures/browserScenarioCapture.js";

const RECORDED: readonly TimedCaptureRow[] = [
  ...BOOK_INIT_ROWS,
  ["DELETE", "/api/books", [{ id: 2 }], 200, [{ id: 2 }]],
  ["GET", "/api/books/2", BOOK_NOT_FOUND, 404],
  ["GET", "/api/books", [FIRST_BOOK]],
];

describe("browser probe request-body admission", () => {
  it("refuses a browser bulk delete probe without selected request bodies", () => {
    const fixture = environmentStateServeFixture(
      timedCaptureEvidence(RECORDED),
    );
    const report = compareEnvironment({
      source: environmentServeSource(fixture),
      captureValue: fixture.capture,
      probes: [
        {
          label: "bulk-delete-without-body",
          value: scenarioCaptureEvidence(
            scenarioCaptureFixture(
              [
                {
                  method: "DELETE",
                  url: "/api/books",
                  status: 200,
                  mediaType: "application/json",
                  body: '[{"id":1}]',
                },
              ],
              {
                request_body: false,
                response_body: true,
                header_values: false,
              },
            ),
          ),
        },
      ],
      operation: "environment-compare",
    });
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(JSON.stringify(report.error)).toContain(
      "capture.network.request_body",
    );
  });

  it("compares a browser bulk delete when request bodies were selected", () => {
    const fixture = environmentStateServeFixture(
      timedCaptureEvidence(RECORDED),
    );
    const report = compareEnvironment({
      source: environmentServeSource(fixture),
      captureValue: fixture.capture,
      probes: [
        {
          label: "bulk-delete-with-body",
          value: scenarioCaptureEvidence(
            scenarioCaptureFixture([
              {
                method: "DELETE",
                url: "/api/books",
                status: 200,
                mediaType: "application/json",
                body: '[{"id":1}]',
                requestMediaType: "application/json",
                requestBody: '[{"id":1}]',
              },
              {
                method: "GET",
                url: "/api/books/1",
                status: 404,
                mediaType: "application/json",
                body: JSON.stringify(BOOK_NOT_FOUND),
              },
            ]),
          ),
        },
      ],
      operation: "environment-compare",
    });
    if (!report.ok) throw report.error;
    expect(report.value.summary).toMatchObject({ steps: 2, equal: 2 });
  });

  it("allows a browser item delete without selecting request bodies", () => {
    const fixture = environmentStateServeFixture(
      timedCaptureEvidence(BOOK_ROWS),
    );
    const report = compareEnvironment({
      source: environmentServeSource(fixture),
      captureValue: fixture.capture,
      probes: [
        {
          label: "item-delete-without-body",
          value: scenarioCaptureEvidence(
            scenarioCaptureFixture(
              [{ method: "DELETE", url: "/api/books/2", status: 204 }],
              {
                request_body: false,
                response_body: true,
                header_values: false,
              },
            ),
          ),
        },
      ],
      operation: "environment-compare",
    });
    if (!report.ok) throw report.error;
    expect(report.value.summary).toMatchObject({ steps: 1, equal: 1 });
  });
});

it("refuses a mapped bulk delete without selected request bodies", () => {
  const seedProject = { id: "seed-project", name: "Seed project" };
  const fixture = environmentStateServeFixture(
    timedCaptureEvidence([
      ["GET", "/api/projects", [seedProject]],
      ["GET", "/api/projects/seed-project", seedProject],
      ["GET", "/api/projects/seed-project/books", [{ id: "seed-book" }]],
      [
        "DELETE",
        "/api/projects/seed-project/books",
        [],
        200,
        [{ id: "seed-book" }],
      ],
      ["GET", "/api/projects/seed-project/books", []],
    ]),
  );
  const report = compareEnvironment({
    source: environmentServeSource(fixture),
    captureValue: fixture.capture,
    probes: [
      {
        label: "mapped-bulk-delete-without-body",
        value: scenarioCaptureEvidence(
          scenarioCaptureFixture(
            [
              {
                method: "GET",
                url: "/api/projects",
                status: 200,
                mediaType: "application/json",
                body: JSON.stringify([
                  { id: "live-project", name: "Seed project" },
                ]),
              },
              {
                method: "DELETE",
                url: "/api/projects/live-project/books",
                status: 200,
                mediaType: "application/json",
                body: "[]",
              },
            ],
            {
              request_body: false,
              response_body: true,
              header_values: false,
            },
          ),
        ),
      },
    ],
    operation: "environment-compare",
  });
  expect(report.ok).toBe(false);
  if (report.ok) return;
  expect(JSON.stringify(report.error)).toContain(
    "capture.network.request_body",
  );
});

describe("environment comparison of bulk writes", () => {
  it("sends a probe's bulk delete body to the served tool, which answers it from the state", () => {
    const fixture = environmentStateServeFixture(
      timedCaptureEvidence(RECORDED),
    );
    const report = compareEnvironment({
      source: environmentServeSource(fixture),
      captureValue: fixture.capture,
      probes: [
        {
          label: "bulk-delete",
          value: timedCaptureEvidence([
            ["GET", "/api/books/1", FIRST_BOOK],
            ["DELETE", "/api/books", [{ id: 1 }], 200, [{ id: 1 }]],
            ["GET", "/api/books/1", BOOK_NOT_FOUND, 404],
          ]),
        },
      ],
      operation: "environment-compare",
    });
    if (!report.ok) throw report.error;
    const [, deleted, read] = report.value.probes[0]!.results;
    expect(deleted).toMatchObject({ env_status: 200, equal: true });
    expect(read).toMatchObject({ env_status: 404, equal: true });
  });

  it("translates the ids a bulk body names with its collection's own mapping", () => {
    const project = { id: 7, name: "Project" };
    const fixture = environmentStateServeFixture(
      timedCaptureEvidence([
        ["GET", "/api/projects", [project]],
        ["GET", "/api/projects/7", project],
        ...RECORDED,
      ]),
    );
    // The probe reuses id 100 for the project and for the first book.
    const live = (id: number) => ({ ...FIRST_BOOK, id });
    const report = compareEnvironment({
      source: environmentServeSource(fixture),
      captureValue: fixture.capture,
      probes: [
        {
          label: "shared-id",
          value: timedCaptureEvidence([
            ["GET", "/api/projects", [{ ...project, id: 100 }]],
            ["GET", "/api/books", [live(100), { ...SECOND_BOOK, id: 101 }]],
            ["DELETE", "/api/books", [{ id: 100 }], 200, [{ id: 100 }]],
            ["GET", "/api/books/100", BOOK_NOT_FOUND, 404],
          ]),
        },
      ],
      operation: "environment-compare",
    });
    if (!report.ok) throw report.error;
    const [, , deleted, read] = report.value.probes[0]!.results;
    expect(deleted).toMatchObject({ env_status: 200, equal: true });
    expect(read).toMatchObject({ env_status: 404, equal: true });
  });
});
