import { expect, it } from "vitest";

import { AnalysisCleanupRelease } from "./analysisCleanupRelease.js";
import {
  analysisErrorWithCleanupDependencies,
  analysisErrorWithCleanupFailure,
} from "./analysisErrorCleanup.js";
import { ProviderCleanupError } from "./providerCleanupError.js";

const failure = () =>
  new ProviderCleanupError(
    "process-ownership",
    ["/tmp/rea-owned"],
    { reason: "removal failed" },
    { operation: "prepare_owned_process" },
  );

it("lets every bound error read one owner's confirmed release", () => {
  const release = new AnalysisCleanupRelease();
  const first = release.bind(failure());
  const second = release.bind(failure());
  expect([first.cleanupIncomplete, second.cleanupIncomplete]).toEqual([
    true,
    true,
  ]);

  release.confirm();

  expect([first.cleanupIncomplete, second.cleanupIncomplete]).toEqual([
    false,
    false,
  ]);
  // An error bound after the release reads it immediately.
  expect(release.bind(failure()).cleanupIncomplete).toBe(false);
});

it("reads a claim bound repeatedly to one error only once", () => {
  let reads = 0;
  const claim = {
    get cleanupReleased() {
      reads += 1;
      return false;
    },
  };
  const error = failure();
  for (let attempt = 0; attempt < 3; attempt += 1)
    error.bindCleanupReleaseClaim(claim);
  expect(error.cleanupIncomplete).toBe(true);
  expect(reads).toBe(1);
});

const resource = (name: string) =>
  new ProviderCleanupError("fixture", [name], { reason: `${name} pending` });

it.each(["owner first", "dependency first"] as const)(
  "completes an owned error only after its owner and every dependency release (%s)",
  (order) => {
    const ownerRelease = new AnalysisCleanupRelease();
    const dependencyRelease = new AnalysisCleanupRelease();
    const dependency = dependencyRelease.bind(resource("descriptor"));
    const error = ownerRelease
      .bind(resource("session"))
      .bindCleanupDependencies([dependency]);
    // Pending dependencies attribute the live resources.
    expect(error.cleanupResources).toEqual(["descriptor"]);

    (order === "owner first" ? ownerRelease : dependencyRelease).confirm();
    expect(error.cleanupIncomplete).toBe(true);
    expect(error.cleanupResources).toEqual([
      order === "owner first" ? "descriptor" : "session",
    ]);

    (order === "owner first" ? dependencyRelease : ownerRelease).confirm();
    expect(error.cleanupIncomplete).toBe(false);
    expect(error.cleanupResources).toEqual([]);
  },
);

it("keeps an owner's pending record when every bound dependency is already complete", () => {
  const release = new AnalysisCleanupRelease();
  const completedRelease = new AnalysisCleanupRelease();
  const completed = completedRelease.bind(resource("completed"));
  completedRelease.confirm();
  const error = release
    .bind(resource("session"))
    .bindCleanupDependencies([completed]);
  expect(error.cleanupIncomplete).toBe(true);
  expect(error.cleanupResources).toEqual(["session"]);
  release.confirm();
  expect(error.cleanupIncomplete).toBe(false);
});

// JADX's retained cleanup: the admission failure reads its descriptors'
// release, the retained cleanup error reads the whole cleanup's release, and
// close composes both with the prerequisite cleanup failure.
it("completes JADX-style owner records composed through the shared helper", () => {
  const descriptorRelease = new AnalysisCleanupRelease();
  const release = new AnalysisCleanupRelease();
  const admission = descriptorRelease.bind(resource("descriptor"));
  const retained = release.bind(
    analysisErrorWithCleanupFailure(admission, resource("workspace")),
  );
  const prerequisiteRelease = new AnalysisCleanupRelease();
  const prerequisite = prerequisiteRelease.bind(resource("java-probe"));
  const closed = analysisErrorWithCleanupDependencies(retained, prerequisite);

  descriptorRelease.confirm();
  expect(admission.cleanupIncomplete).toBe(false);
  expect(retained.cleanupIncomplete).toBe(true);
  expect(closed.cleanupIncomplete).toBe(true);

  release.confirm();
  expect(retained.cleanupIncomplete).toBe(false);
  expect(closed.cleanupIncomplete).toBe(true);
  expect(closed.cleanupResources).toEqual(["java-probe"]);

  prerequisiteRelease.confirm();
  expect(closed.cleanupIncomplete).toBe(false);
});

it("keeps an owner's record bound to a composition of owned parts", () => {
  const primaryRelease = new AnalysisCleanupRelease();
  const cleanupRelease = new AnalysisCleanupRelease();
  const ownerRelease = new AnalysisCleanupRelease();
  const composed = ownerRelease.bind(
    analysisErrorWithCleanupDependencies(
      primaryRelease.bind(resource("worker")),
      cleanupRelease.bind(resource("root")),
    ),
  );
  primaryRelease.confirm();
  cleanupRelease.confirm();
  expect(composed.cleanupIncomplete).toBe(true);
  ownerRelease.confirm();
  expect(composed.cleanupIncomplete).toBe(false);
});
