import { expect, it } from "vitest";
import { completeJavaScriptAnalysisSteps } from "./JavaScriptAnalysisControl.js";
import { collectElectronWrappedCallPathsSteps } from "../../domain/javascript/electronWrappedCallPaths.js";
import {
  indexJavaScriptBindingsWithReceiversSteps,
  indexJavaScriptElectronIdentitySteps,
} from "../../domain/javascript/javascriptSemanticAnalysis.js";
import { completeSemanticSteps } from "../../domain/javascript/javascriptSemanticTraversal.js";
import { parseJavaScriptSource } from "../../domain/javascript/javascriptSourceParser.js";
import { createJavaScriptAnalysisAccumulator } from "../../domain/javascript/javascriptStaticAnalysisState.js";

it("cancels actual call-path work while its first seed indexes a long block", async () => {
  const source = `const e = require("electron"); {
    e.ipcMain.on("first", event => event.sender.copy());
    ${"0;".repeat(2048)}
  }`;
  const parsed = parseJavaScriptSource(source);
  if (parsed === null) throw new Error("Expected parsed source");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  );
  const identity = completeSemanticSteps(
    indexJavaScriptElectronIdentitySteps(parsed.program, index.bindings),
  );
  const accumulator = createJavaScriptAnalysisAccumulator(source.length);
  const work = collectElectronWrappedCallPathsSteps(
    parsed.program,
    index.bindings,
    source,
    accumulator,
    identity,
    () => index.indexMemberMutationFactsSteps(),
  );
  // The first candidate has not yet been expanded: this checkpoint is inside
  // its block indexing, before the walker's completed batch is yielded.
  expect(work.next()).toEqual({ done: false, value: undefined });
  expect(accumulator.ipc).toEqual([]);
  const controller = new AbortController();
  const reason = { request: "cancel prefix indexing" };
  controller.abort(reason);
  await expect(
    completeJavaScriptAnalysisSteps(work, controller.signal),
  ).rejects.toMatchObject({ reason: "cancelled", cause: reason });
  expect(work.next()).toEqual({ done: true, value: undefined });
  expect(accumulator.ipc).toEqual([]);
  expect(accumulator.electronCallPathLimitReached).toBeUndefined();

  // A new analysis owns a new index and can still complete the same source.
  const completed = createJavaScriptAnalysisAccumulator(source.length);
  expect(
    completeSemanticSteps(
      collectElectronWrappedCallPathsSteps(
        parsed.program,
        index.bindings,
        source,
        completed,
        identity,
        () => index.indexMemberMutationFactsSteps(),
      ),
    ),
  ).toContainEqual(expect.objectContaining({ entry: "first", conditions: [] }));
  expect(completed.electronCallPathLimitReached).toBeUndefined();
});

it("cancels while a late initializer requests member-mutation indexing", async () => {
  const source = `
    const name = "electron";
    const holder = {};
    function register() {
      load().ipcMain.on("ping", () => {});
    }
    var load = () => holder.load(name);
    register();
  `;
  const parsed = parseJavaScriptSource(source);
  if (parsed === null) throw new Error("Expected parsed source");
  const index = completeSemanticSteps(
    indexJavaScriptBindingsWithReceiversSteps(parsed.program),
  );
  const identity = completeSemanticSteps(
    indexJavaScriptElectronIdentitySteps(parsed.program, index.bindings),
  );
  const accumulator = createJavaScriptAnalysisAccumulator(source.length);
  let indexingStarted = false;
  function* indexMemberMutationFacts(): Generator<void, void> {
    indexingStarted = true;
    yield;
    yield* index.indexMemberMutationFactsSteps();
  }
  const work = collectElectronWrappedCallPathsSteps(
    parsed.program,
    index.bindings,
    source,
    accumulator,
    identity,
    indexMemberMutationFacts,
  );

  while (!indexingStarted) {
    const next = work.next();
    expect(next.done).toBe(false);
  }
  expect(index.bindings.memberMutationFactsComplete).toBe(false);

  const controller = new AbortController();
  const reason = { request: "cancel mutation indexing" };
  controller.abort(reason);
  await expect(
    completeJavaScriptAnalysisSteps(work, controller.signal),
  ).rejects.toMatchObject({ reason: "cancelled", cause: reason });
  expect(work.next()).toEqual({ done: true, value: undefined });
  expect(index.bindings.memberMutationFactsComplete).toBe(false);
});

it("counts unknowns once when mutation indexing retries a seed", () => {
  const source = `
    const holder = {};
    holder.load = require;
    function register(value) {
      switch (value) {
        case choose():
          break;
        case "run":
          load().ipcMain.on("ping", () => {});
      }
    }
    var load = () => holder.load("electron");
    register("run");
  `;
  const collectUnknowns = (eager: boolean) => {
    const parsed = parseJavaScriptSource(source);
    if (parsed === null) throw new Error("Expected parsed source");
    const index = completeSemanticSteps(
      indexJavaScriptBindingsWithReceiversSteps(parsed.program),
    );
    if (eager) completeSemanticSteps(index.indexMemberMutationFactsSteps());
    const identity = completeSemanticSteps(
      indexJavaScriptElectronIdentitySteps(parsed.program, index.bindings),
    );
    const accumulator = createJavaScriptAnalysisAccumulator(source.length);
    let indexRequests = 0;
    completeSemanticSteps(
      collectElectronWrappedCallPathsSteps(
        parsed.program,
        index.bindings,
        source,
        accumulator,
        identity,
        () => {
          indexRequests += 1;
          return index.indexMemberMutationFactsSteps();
        },
      ),
    );
    return { indexRequests, unknownFindings: accumulator.unknownFindings };
  };

  const eager = collectUnknowns(true);
  const retried = collectUnknowns(false);

  expect(retried.indexRequests).toBe(1);
  expect(retried.unknownFindings).toBe(eager.unknownFindings);
});
