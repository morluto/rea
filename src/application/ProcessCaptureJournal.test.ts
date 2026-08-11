import { expect, it } from "vitest";

import type { ProcessCaptureEventJournalEntry } from "../domain/processCapture.js";
import { createProcessCaptureJournal } from "./ProcessCaptureJournal.js";

it("publishes journal entries in capture order and supports nested recording", () => {
  const journal = createProcessCaptureJournal();
  const observed: ProcessCaptureEventJournalEntry[] = [];
  const unsubscribe = journal.subscribe((entry) => observed.push(entry));
  journal.recordEvent("lifecycle", 0);
  const settlementEntry = journal.record("lifecycle", 1);
  unsubscribe();
  journal.recordEvent("frames", 0);

  expect(journal.entries).toEqual([
    { capture_order: 0, collection: "lifecycle", index: 0 },
    { capture_order: 1, collection: "lifecycle", index: 1 },
    { capture_order: 2, collection: "frames", index: 0 },
  ]);
  expect(observed).toEqual(journal.entries.slice(0, 2));
  expect(settlementEntry).toEqual(journal.entries[1]);

  const nestedJournal = createProcessCaptureJournal();
  const notifications: string[] = [];
  nestedJournal.subscribe((entry) => {
    notifications.push(`a:${String(entry.capture_order)}`);
    if (entry.capture_order === 0) nestedJournal.record("frames", 1);
  });
  nestedJournal.subscribe((entry) =>
    notifications.push(`b:${String(entry.capture_order)}`),
  );
  nestedJournal.record("frames", 0);

  expect(notifications).toEqual(["a:0", "b:0", "a:1", "b:1"]);
});
