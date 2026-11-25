import { describe, expect, it } from "vitest";

import {
  BULK_EMPTY_TAG_ROWS,
  CREATION_ORDER_ROWS,
  DERIVED_TEXT_ROWS,
  ID_OR_TITLE_ROWS,
  MINIMAL_CONTACT_ROWS,
  SHELF_SORTED_ROWS,
  SHELF_TIE_ROWS,
  SHELF_GUESS_ROWS,
  ID_SORTED_READ_ROWS,
  UNSORTED_PENDING_ROWS,
  IN_PLACE_THEN_LAST_ROWS,
  IN_PLACE_THEN_SORTED_ROWS,
  UNSORTED_SEED_ROWS,
  CONFIRMED_RENAME_ROWS,
  UNPLACED_CREATE_ROWS,
} from "../../../tests/fixtures/environmentStateFormWrites.js";
import { planOf } from "../../../tests/fixtures/environmentStateWrites.js";
import { mergedCreatePlan } from "./environmentStateWriteCreateCalls.js";
import { resortedMembers } from "./environmentStateWriteExplain.js";
import type { WriteBody } from "./environmentStateWriteRules.js";

const BY_NAME = {
  rule: "sorted",
  field: "name",
  direction: "ascending",
} as const;

describe("create members a form sent empty", () => {
  it("accepts either spelling of a member two creates sent empty differently, filling the earliest", () => {
    const body: WriteBody = {
      accepted: ["name", "note"],
      fixed: [],
      required: ["name"],
      identity: null,
      kinds: [],
      blank: [{ member: "note", sent: "" }],
    };
    const rules = [
      { field: "id", rule: "identity", generator: "sequence" },
      { field: "name", rule: "echo" },
      { field: "note", rule: "echo" },
    ] as const;
    const merged = mergedCreatePlan(
      { rules: [...rules], body },
      { id: 1, name: "One", note: "" },
      {
        entity: { id: 2, name: "Two", note: null },
        body: { name: "Two", note: null },
        rules: [...rules],
        contract: { ...body, blank: [{ member: "note", sent: null }] },
      },
    );
    expect(merged?.body).toMatchObject({
      required: ["name"],
      blank: [
        { member: "note", sent: "" },
        { member: "note", sent: null },
      ],
    });
  });
});

describe("a create with only what a person must give", () => {
  it("serves a create whose minimal call left string members `null` and an empty flag spelled another way", () => {
    expect(planOf(MINIMAL_CONTACT_ROWS, "post_contacts")).toMatchObject({
      served: true,
      body: {
        required: ["lastName"],
        blank: expect.arrayContaining([
          { member: "firstName", sent: null },
          { member: "email", sent: null },
          { member: "emailOptedOut", sent: false },
          { member: "emailOptedOut", sent: null },
        ]),
      },
    });
  });
});

describe("collections kept sorted", () => {
  it("learns the title order from a rename when the creates fit both id and title order", () => {
    const byTitle = { rule: "sorted", field: "title", direction: "ascending" };
    expect(planOf(ID_OR_TITLE_ROWS, "put_folders_by_id")).toMatchObject({
      served: true,
      insert: byTitle,
    });
    expect(planOf(ID_OR_TITLE_ROWS, "post_folders")).toMatchObject({
      insert: byTitle,
    });
  });

  it("learns no sort from a rename that an earlier read of the creates' order rules out", () => {
    const byTitle = { rule: "sorted", field: "title", direction: "ascending" };
    expect(planOf(CREATION_ORDER_ROWS, "post_folders").insert).not.toEqual(
      byTitle,
    );
    expect(planOf(CREATION_ORDER_ROWS, "put_folders_by_id")).toMatchObject({
      served: false,
    });
  });

  it("learns the name order from a rename when a read sorted by its query placed the create", () => {
    const byName = { rule: "sorted", field: "name", direction: "ascending" };
    expect(planOf(SHELF_SORTED_ROWS, "put_books_by_id")).toMatchObject({
      served: true,
      insert: byName,
    });
  });

  it("learns no sort from a rename that moving the renamed entity alone cannot reach", () => {
    const plan = planOf(UNSORTED_SEED_ROWS, "put_folders_by_id");
    expect(plan.served).toBe(false);
    expect(plan.insert).toBeNull();
  });

  it("gives a rename no sort that only an unplaced create's guess shows", () => {
    expect(
      planOf(UNPLACED_CREATE_ROWS, "patch_labels_by_id").insert,
    ).toBeNull();
  });

  it("learns no sort from a rename when an earlier confirmed rename left its entity out of that order", () => {
    const plan = planOf(CONFIRMED_RENAME_ROWS, "put_folders_by_id");
    expect(plan.served).toBe(false);
    expect(plan.insert).toBeNull();
  });

  it("learns no sort from a read its query sorts, whose ties need not follow the collection's order", () => {
    expect(planOf(SHELF_TIE_ROWS, "put_books_by_id").insert).toBeNull();
  });

  it("withholds a rename whose read only an unplaced create's guessed order explains", () => {
    expect(planOf(SHELF_GUESS_ROWS, "put_books_by_id").served).toBe(false);
  });

  it("learns no sort from renames whose moves, made in turn as serving makes them, do not reach the list", () => {
    const plan = planOf(UNSORTED_PENDING_ROWS, "put_folders_by_id");
    expect(plan.served).toBe(false);
    expect(plan.insert).toBeNull();
  });

  it.each([
    ["Delta then Zulu", IN_PLACE_THEN_LAST_ROWS],
    ["Zulu then Delta", IN_PLACE_THEN_SORTED_ROWS],
  ])(
    "learns no sort that a list showing an earlier rename in place rules out (%s)",
    (_name, rows) => {
      const plan = planOf(rows, "patch_labels_by_id");
      expect(plan.served).toBe(false);
      expect(plan.insert).toBeNull();
    },
  );

  it("learns the sort from a rename after a read its query sorts by id showed an earlier rename", () => {
    expect(planOf(ID_SORTED_READ_ROWS, "put_books_by_id")).toMatchObject({
      served: true,
      insert: BY_NAME,
    });
  });

  it("serves a bulk update whose recordings echo the empty values each call sent", () => {
    expect(planOf(BULK_EMPTY_TAG_ROWS, "patch_labels")).toMatchObject({
      served: true,
    });
  });

  it("places writes that produce equal names in the order they were sent", () => {
    const entity = (id: string, name: string) => ({ id, fields: { name } });
    const a = entity("1", "a");
    const b = entity("2", "b");
    const c = entity("3", "c");
    const d = entity("4", "d");
    const movedC = entity(c.id, "h");
    const movedB = entity(b.id, "h");
    const order = resortedMembers(
      BY_NAME,
      [a, b, c, d],
      [
        { before: c, after: movedC },
        { before: b, after: movedB },
      ],
    );
    expect(order).toEqual([a, d, movedC, movedB]);
  });
});

describe("answers that show stored values otherwise than reads", () => {
  it("withholds a later create that stored an unruled field otherwise, without blocking checks of later writes", () => {
    expect(planOf(DERIVED_TEXT_ROWS, "post_tags")).toMatchObject({
      served: false,
      reason: "unexplained-change",
    });
    expect(planOf(DERIVED_TEXT_ROWS, "delete_tags_by_id")).toMatchObject({
      served: true,
    });
  });
});
