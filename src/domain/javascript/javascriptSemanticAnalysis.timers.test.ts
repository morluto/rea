import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

const timerOperations = (source: string) =>
  analyzeJavaScriptSemantics(source).timerOperations;

it("does not link cancellation to a timer after its handle is cleared", () => {
  const operations = timerOperations(`
    let handle = setTimeout(work, 10);
    handle = null;
    clearTimeout(handle);
  `);

  expect(operations.at(-1)).toMatchObject({
    kind: "cancel",
    linkedTimerId: null,
    resolution: "unresolved",
  });
});

it("links cancellation to the latest preceding timer assignment", () => {
  const operations = timerOperations(`
    let handle = setTimeout(first, 10);
    handle = setTimeout(second, 20);
    clearTimeout(handle);
  `);

  expect(operations[2]).toMatchObject({
    kind: "cancel",
    linkedTimerId: operations[1]?.timerId,
    resolution: "complete",
  });
});

it("does not link cancellation to a timer scheduled later", () => {
  const operations = timerOperations(`
    let handle;
    clearTimeout(handle);
    handle = setTimeout(work, 10);
  `);

  expect(operations[0]).toMatchObject({
    kind: "cancel",
    linkedTimerId: null,
    resolution: "unresolved",
  });
});

it("preserves an immutable timer handle captured by a closure", () => {
  const operations = timerOperations(`
    const handle = setTimeout(work, 10);
    const cancel = () => clearTimeout(handle);
  `);

  expect(operations[1]).toMatchObject({
    kind: "cancel",
    linkedTimerId: operations[0]?.timerId,
    resolution: "complete",
  });
});

it("keeps cancellation uncertain after a conditional handle replacement", () => {
  const operations = timerOperations(`
    let handle = setTimeout(work, 10);
    if (condition) handle = null;
    clearTimeout(handle);
  `);

  expect(operations.at(-1)).toMatchObject({
    kind: "cancel",
    linkedTimerId: operations[0]?.timerId,
    resolution: "partial",
  });
});

it("keeps cancellation uncertain across a mutable closure capture", () => {
  const operations = timerOperations(`
    let handle = setTimeout(work, 10);
    const cancel = () => clearTimeout(handle);
    handle = null;
  `);

  expect(operations[1]).toMatchObject({
    kind: "cancel",
    linkedTimerId: operations[0]?.timerId,
    resolution: "partial",
  });
});

it("keeps cancellation within the handle family that Node clears", () => {
  // Node keeps timeouts and immediates in separate handle families:
  // clearTimeout/clearInterval act only on a Timeout, clearImmediate only on an
  // Immediate. Clearing within a family always cancels; clearing across them is
  // runtime-dependent (setImmediate then clearTimeout never cancels, but
  // setTimeout then clearImmediate does on some supported Node versions), so a
  // cross-family clear is retained as unresolved rather than as proven either way.
  const pairs = [
    ["setTimeout", "clearTimeout", true],
    ["setTimeout", "clearInterval", true],
    ["setTimeout", "clearImmediate", false],
    ["setInterval", "clearTimeout", true],
    ["setInterval", "clearInterval", true],
    ["setInterval", "clearImmediate", false],
    ["setImmediate", "clearTimeout", false],
    ["setImmediate", "clearInterval", false],
    ["setImmediate", "clearImmediate", true],
  ] as const;

  for (const [schedule, cancel, linked] of pairs) {
    const operations = timerOperations(`
      const handle = ${schedule}(work, 10);
      ${cancel}(handle);
    `);

    expect(operations[1], `${schedule} then ${cancel}`).toMatchObject({
      kind: "cancel",
      method: cancel,
      linkedTimerId: linked ? operations[0]?.timerId : null,
      resolution: linked ? "complete" : "unresolved",
    });
  }
});
