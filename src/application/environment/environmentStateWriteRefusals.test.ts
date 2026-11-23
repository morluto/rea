import { EnvironmentStateStore } from "./environmentStateStore.js";
import { environmentToolAnswer } from "./environmentToolAnswer.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import type { StateWritePlan } from "../../domain/analysisView/environmentStateWriteRules.js";
import { describe, expect, it } from "vitest";

import type { TimedCaptureRow } from "../../../tests/fixtures/analysisView.js";
import {
  servedFrom,
  type Served,
} from "../../../tests/fixtures/environmentStateServing.js";
import {
  FIRST_BOOK,
  SECOND_BOOK,
  renamedBook,
  type Book,
} from "../../../tests/fixtures/environmentStateWrites.js";
import { MAX_JSON_DEPTH, type JsonValue } from "../../domain/jsonValue.js";
import type { ReplayArguments } from "./environmentReplay.js";
import { STATE_INTAKE_LIMIT_BYTES } from "./environmentStateDocument.js";

const DARK = { theme: "dark", meta: { n: 1 } };
const LIGHT = { theme: "light", meta: { n: 2 } };

const SETTINGS_PATH = "/api/orgs/1/settings";
const settingsRows = (
  patchPath = SETTINGS_PATH,
  updated: JsonValue = LIGHT,
): readonly TimedCaptureRow[] => [
  ["GET", SETTINGS_PATH, DARK],
  ["PATCH", patchPath, updated, 200, updated],
  ["GET", SETTINGS_PATH, updated],
];
const SETTINGS_ROWS = settingsRows();

const READ_SETTINGS = "get_orgs_settings_by_id";
const PATCH_SETTINGS = "patch_orgs_settings_by_id";

/** Every refused call is a tool error naming its problem, and leaves the state as it was. */
const expectRefusedUnchanged = (
  served: Served,
  refused: readonly (readonly [string, ReplayArguments, string])[],
): void => {
  const before = served.snapshot();
  for (const [name, args, message] of refused) {
    expect(served.refusal(name, args)).toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining(message),
    });
    expect(served.snapshot()).toBe(before);
  }
};

/** What data/get reports loads back through data/add byte for byte. */
const expectReloadsUnchanged = (served: Served): void => {
  const before = served.snapshot();
  expect(served.store.replace(JSON.parse(before)).ok).toBe(true);
  expect(served.snapshot()).toBe(before);
};

const nested = (depth: number): JsonValue =>
  Array.from({ length: depth }).reduce<JsonValue>((inner) => [inner], 1);

describe("served document writes", () => {
  it("changes only the recorded document path with the learned member names and types", () => {
    const query = "scope=panel&view=full";
    const reversed = "view=full&scope=panel";
    const gray = { ...LIGHT, theme: "gray" };
    const settings = servedFrom([
      ...settingsRows(`${SETTINGS_PATH}?${query}`),
      ["PATCH", `${SETTINGS_PATH}?${reversed}`, gray, 200, gray],
      ["GET", SETTINGS_PATH, gray],
    ]);
    expect(settings.state.writes.get(PATCH_SETTINGS)).toMatchObject({
      served: true,
      effect: "document",
    });
    expectRefusedUnchanged(settings, [
      [
        PATCH_SETTINGS,
        { id: "2", body: { theme: "blue" } },
        "holds this document only at /api/orgs/1/settings",
      ],
      [
        PATCH_SETTINGS,
        { id: "1", body: { theme: 5, extra: true } },
        "Member theme must be a JSON string",
      ],
      [
        PATCH_SETTINGS,
        { id: "1", body: { extra: true } },
        "Member extra is not one the capture showed stored",
      ],
    ]);
    expect(settings.answer(READ_SETTINGS, { id: "1" }).body).toEqual(DARK);
    const patch = settings.source.manifest.tools.find(
      ({ name }) => name === PATCH_SETTINGS,
    )!;
    const respond = environmentToolAnswer(settings.source, settings.store);
    for (const [rawQuery, queryArgs, theme, exact] of [
      [query, {}, "blue", true],
      [reversed, {}, "green", false],
      [undefined, { scope: "panel", view: "full" }, "yellow", false],
      [undefined, {}, "purple", true],
    ] as const) {
      const body = { theme, meta: DARK.meta };
      expect
        .soft(
          respond(patch, { id: "1", ...queryArgs, body: { theme } }, rawQuery),
        )
        .toMatchObject({
          ok: true,
          value: {
            body,
            replay: { exact_match: exact, record_ordinal: 1 },
            state: { view: "document-write", path: "/api/orgs/1/settings" },
          },
        });
      expect(settings.answer(READ_SETTINGS, { id: "1" }).body).toEqual(body);
    }
  });

  it.each([
    [
      "changes a member's type",
      SETTINGS_PATH,
      { theme: 5, meta: LIGHT.meta },
      { reason: "unexplained-change" },
    ],
    ["targets another path", "/api/orgs/2/settings", LIGHT, {}],
  ] as const)(
    "withholds a recorded document write that %s",
    (_, path, updated, reason) => {
      const settings = servedFrom(settingsRows(path, updated));
      expect(settings.state.writes.get(PATCH_SETTINGS)).toMatchObject({
        served: false,
        ...reason,
      });
    },
  );
});

describe("values the state can load back", () => {
  it("preserves nested prototype-named data through writes and reload", () => {
    const settings = servedFrom(SETTINGS_ROWS);
    const meta = JSON.parse(
      '{"__proto__":{"n":1},"constructor":2,"prototype":3}',
    );
    expect(
      settings.answer(PATCH_SETTINGS, { id: "1", body: { meta } }).body,
    ).toEqual({ theme: "dark", meta });
    expect(settings.answer(READ_SETTINGS, { id: "1" }).body).toEqual({
      theme: "dark",
      meta,
    });
    expectReloadsUnchanged(settings);
  });

  it("refuses a body value data/add would refuse, whatever member carries it", () => {
    const settings = servedFrom(SETTINGS_ROWS);
    const unexact =
      "Member meta would hold a value that is not exactly representable JSON";
    expectRefusedUnchanged(settings, [
      [PATCH_SETTINGS, { id: "1", body: { meta: { n: 1e20 } } }, unexact],
      [
        PATCH_SETTINGS,
        { id: "1", body: { meta: { n: nested(MAX_JSON_DEPTH) } } },
        unexact,
      ],
    ]);
    settings.answer(PATCH_SETTINGS, { id: "1", body: { meta: { n: 3 } } });
    expectReloadsUnchanged(settings);
  });

  it("refuses an increment past the exact integers, so data/get still loads back", () => {
    const versioned = (entry: Book, version: number): Book => ({
      ...entry,
      version,
    });
    const last = Number.MAX_SAFE_INTEGER;
    const edition = versioned(renamedBook(SECOND_BOOK, "Second Edition", 3), 2);
    const books = servedFrom([
      [
        "GET",
        "/api/books",
        [versioned(FIRST_BOOK, last - 1), versioned(SECOND_BOOK, 1)],
      ],
      ["GET", "/api/books/1", versioned(FIRST_BOOK, last - 1)],
      ["GET", "/api/books/2", versioned(SECOND_BOOK, 1)],
      ["PATCH", "/api/books/2", edition, 200, { name: "Second Edition" }],
      ["GET", "/api/books/2", edition],
    ]);
    const rename = (name: string) => ({ id: "1", body: { name } });
    expect(
      books.answer("patch_books_by_id", rename("Renamed")).body,
    ).toMatchObject({ version: last });
    expectRefusedUnchanged(books, [
      [
        "patch_books_by_id",
        rename("Renamed Again"),
        "Field version would hold a value that is not exactly representable JSON",
      ],
    ]);
    expectReloadsUnchanged(books);
  });
});

describe("the state size limit", () => {
  it("keeps the size data/get writes as each write changes the state", () => {
    const books = servedFrom();
    const settings = servedFrom(SETTINGS_ROWS);
    const tracked = (served: Served) =>
      expect(served.store.byteLength()).toBe(
        Buffer.byteLength(served.snapshot(), "utf8"),
      );
    tracked(books);
    books.answer("post_books", { body: { name: "Ünïcode Bøok" } });
    tracked(books);
    books.answer("patch_books_by_id", { id: "3", body: { name: "Short" } });
    tracked(books);
    books.answer("delete_books_by_id", { id: "1" });
    books.answer("delete_books_by_id", { id: "2" });
    books.answer("delete_books_by_id", { id: "3" });
    tracked(books);
    books.answer("post_books", { body: { name: "Only Book" } });
    tracked(books);
    settings.answer(PATCH_SETTINGS, { id: "1", body: { theme: "dark blue" } });
    tracked(settings);
    expect(settings.store.replace(JSON.parse(settings.snapshot())).ok).toBe(
      true,
    );
    tracked(settings);
  });

  it("refuses a create that would take data/get past what data/add loads", () => {
    const books = servedFrom();
    // Each answer renders the book, so each stays under the reply body limit.
    const create = { body: { name: "a".repeat(100_000) } };
    let refused: ReturnType<Served["call"]> | undefined;
    for (let made = 0; made < 200 && refused === undefined; made += 1) {
      const result = books.call("post_books", create);
      if (!result.ok) refused = result;
    }
    const before = books.snapshot();
    expect(Buffer.byteLength(before, "utf8")).toBeLessThanOrEqual(
      STATE_INTAKE_LIMIT_BYTES,
    );
    expect(refused?.ok === false && refused.error).toMatchObject({
      resource: "capacity",
      reportedLimits: { max_state_bytes: STATE_INTAKE_LIMIT_BYTES },
    });
    expect(books.refusal("post_books", create)).toMatchObject({
      code: "resource_constraint",
    });
    expect(books.snapshot()).toBe(before);
    expectReloadsUnchanged(books);
    // A smaller state has room again.
    books.answer("delete_books_by_id", { id: "3" });
    expect(books.answer("post_books", create).status).toBe(201);
  });
});

it.each(["clock", "held-clock", "nested-clock"] as const)(
  "refuses a legacy served %s plan with an unknown clock before changing state or generators",
  (rule) => {
    const fixture = servedFrom();
    const original = fixture.state.writes.get("patch_books_by_id");
    if (original === undefined || !original.served)
      throw new Error("Expected served fixture update");
    const format = { kind: "epoch", unit: "ms" } as const;
    const plan: StateWritePlan = {
      ...original,
      rules:
        rule === "nested-clock"
          ? [{ field: "updated_at", rule, format, members: ["at"] }]
          : [{ field: "updated_at", rule, format }],
    };
    const writes = new Map(fixture.state.writes).set(plan.tool, plan);
    const state = { ...fixture.state, writeClock: null, writes };
    const store = new EnvironmentStateStore(state);
    const respond = environmentToolAnswer(fixture.source, store);
    const tool = fixture.source.manifest.tools.find(
      (candidate) => candidate.name === plan.tool,
    );
    const deletion = fixture.source.manifest.tools.find(
      (candidate) => candidate.name === "delete_books_by_id",
    );
    if (tool === undefined || deletion === undefined)
      throw new Error("Expected fixture tools");
    const before = JSON.stringify(store.snapshot());
    const pending = store.pendingWrite();
    const result = respond(tool, { id: "1", body: { name: "Refused" } });
    if (result.ok) throw new Error("Expected unknown clock refusal");
    expect(result.error._tag).toBe("AnalysisInputError");
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("requires a known write clock"),
    });
    expect(JSON.stringify(store.snapshot())).toBe(before);
    expect(store.pendingWrite()).toEqual(pending);
    expect(store.state.writes.get(plan.tool)).toBe(plan);
    // Independent writes keep working; the guard does not erase imported metadata.
    expect(respond(deletion, { id: "1" }).ok).toBe(true);
    expect(JSON.stringify(store.snapshot())).not.toBe(before);
  },
);
