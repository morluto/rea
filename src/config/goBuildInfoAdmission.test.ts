import { expect, it } from "vitest";
import { AnalysisSettings } from "../application/AnalysisSettings.js";
import { explicitSetupRegistrationEnvironment } from "../application/SetupRegistrationEnvironment.js";
import { launchAnalysisSetting } from "./analysisSettings.js";
import { parseEnvironment } from "./environment.js";
import { parseGoBuildInfoAdmission } from "./goBuildInfoAdmission.js";
import { runtimeGoBuildInfoAdmission } from "./runtimeAnalysisSettings.js";

const setting = "go.max_build_info_bytes";
const key = "REA_GO_MAX_BUILD_INFO_BYTES";

it("shares byte bounds, default and launch provenance across settings and setup", () => {
  expect(parseGoBuildInfoAdmission({})).toEqual({
    ok: true,
    value: { maximumBytes: 1048576, source: "default" },
  });
  for (const bytes of [1, 2097152, 16777216]) {
    const environment = { [key]: String(bytes) };
    expect(parseGoBuildInfoAdmission(environment)).toEqual({
      ok: true,
      value: { maximumBytes: bytes, source: "setting" },
    });
    expect(launchAnalysisSetting(setting, environment)).toEqual({
      ok: true,
      value: { value: bytes, source: "setting" },
    });
    expect(explicitSetupRegistrationEnvironment(environment)).toEqual(
      environment,
    );
  }
});

it.each(["0", "-1", "01", "1.5", "1e6", "", " 2", "2MiB", "16777217"])(
  "rejects launch value %j without disabling runtime repair",
  (value) => {
    const environment = { [key]: value };
    const owned = parseGoBuildInfoAdmission(environment);
    expect(owned.ok).toBe(false);
    expect(launchAnalysisSetting(setting, environment)).toEqual(owned);
    expect(parseEnvironment(environment).ok).toBe(true);
    const store = new AnalysisSettings(environment);
    const admission = runtimeGoBuildInfoAdmission(environment, store.read);
    expect(admission().ok).toBe(false);
    expect(
      store.update({ changes: [{ setting, action: "set", value: 2097152 }] })
        .ok,
    ).toBe(true);
    expect(admission()).toEqual({
      ok: true,
      value: { maximumBytes: 2097152, source: "runtime" },
    });
    expect(store.update({ changes: [{ setting, action: "reset" }] }).ok).toBe(
      true,
    );
    expect(admission().ok).toBe(false);
  },
);

it("keeps accepted snapshots and launch reset independent of later updates", async () => {
  const environment = { [key]: "2097152" };
  const store = new AnalysisSettings(environment);
  const admission = runtimeGoBuildInfoAdmission(environment, store.read);
  // Composition captures the launch baseline once.
  environment[key] = "0";
  await store.run(async () => {
    expect(
      store.update({ changes: [{ setting, action: "set", value: 3145728 }] })
        .ok,
    ).toBe(true);
    await Promise.resolve();
    expect(admission()).toEqual({
      ok: true,
      value: { maximumBytes: 2097152, source: "setting" },
    });
  });
  expect(admission()).toEqual({
    ok: true,
    value: { maximumBytes: 3145728, source: "runtime" },
  });
  const revision = store.read().revision;
  for (const value of [0, -1, 1.5, 16777217]) {
    expect(
      store.update({ changes: [{ setting, action: "set", value }] }).ok,
    ).toBe(false);
    expect(store.read().revision).toBe(revision);
  }
  expect(store.update({ changes: [{ setting, action: "reset" }] }).ok).toBe(
    true,
  );
  expect(admission()).toEqual({
    ok: true,
    value: { maximumBytes: 2097152, source: "setting" },
  });
});
