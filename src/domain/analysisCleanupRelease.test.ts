import { expect, it } from "vitest";

import { AnalysisCleanupRelease } from "./analysisCleanupRelease.js";
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
