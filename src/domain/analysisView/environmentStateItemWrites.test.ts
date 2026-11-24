import { describe, expect, it } from "vitest";

import {
  BOOKMARK_TOGGLE_ROWS,
  CREATES_BY_TITLE_ROWS,
  NULL_THEN_STARRED_ROWS,
  RANKED_AFTER_DELETE_ROWS,
  REFUTED_TITLE_SORT_ROWS,
  feedEntry,
} from "../../../tests/fixtures/environmentStateItemWrites.js";
import { planOf } from "../../../tests/fixtures/environmentStateWrites.js";

describe("item writes", () => {
  it("learns a create's sort from a later list its full order follows, after one create was placed last", () => {
    expect(planOf(CREATES_BY_TITLE_ROWS, "post_folders")).toMatchObject({
      served: true,
      insert: { rule: "sorted", field: "title", direction: "ascending" },
    });
    expect(planOf(CREATES_BY_TITLE_ROWS, "delete_folders_by_id")).toMatchObject(
      { served: true },
    );
  });

  it("keeps a sort an earlier list ruled out away from a create, after the entity that ruled it out is deleted", () => {
    expect(planOf(RANKED_AFTER_DELETE_ROWS, "post_folders")).toMatchObject({
      served: true,
      insert: { rule: "sorted", field: "position", direction: "ascending" },
    });
  });

  it("serves no action whose calls flipped its flag one way only", () => {
    const starred = feedEntry(1, true, "2026-10-17T18:00:03.120000Z");
    expect(
      planOf(
        [
          ...BOOKMARK_TOGGLE_ROWS.slice(0, 4),
          ["GET", "/api/entries/1", starred],
        ],
        "put_entries_bookmark_by_id",
      ),
    ).toMatchObject({ served: false });
  });

  it("does not learn a title sort an earlier update's kept order ruled out", () => {
    const ascending = {
      rule: "sorted",
      field: "title",
      direction: "ascending",
    };
    const update = planOf(REFUTED_TITLE_SORT_ROWS, "patch_folders_by_id");
    const created = planOf(REFUTED_TITLE_SORT_ROWS, "post_folders");
    expect(update).toMatchObject({ served: true });
    expect(update.insert).not.toEqual(ascending);
    expect(created.insert).not.toEqual(ascending);
  });

  it("serves no toggle when an earlier call found the flag null", () => {
    const plan = planOf(NULL_THEN_STARRED_ROWS, "put_entries_bookmark_by_id");
    expect(plan).toMatchObject({ served: false });
    expect(plan.rules).not.toContainEqual({
      field: "starred",
      rule: "toggle",
    });
  });

  it("serves no toggle a call left its flag unchanged under", () => {
    const unchanged = feedEntry(1, false, "2026-10-17T18:00:08.050000Z");
    expect(
      planOf(
        [
          ...BOOKMARK_TOGGLE_ROWS,
          ["PUT", "/api/entries/1/bookmark", "", 204],
          ["GET", "/api/entries/1", unchanged],
        ],
        "put_entries_bookmark_by_id",
      ),
    ).toMatchObject({ served: false });
  });
});
