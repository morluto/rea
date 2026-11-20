import { describe, expect, it } from "vitest";
import { runSettledConcurrent } from "../../../scripts/lib/verify-package-core.mjs";
import { ArtifactResourceScope } from "../../../src/resources/index.js";
import { withReusableJavaScriptScopeForTest } from "../../support/javascriptApplicationScope.js";

describe("withReusableJavaScriptScopeForTest", () => {
  it("re-registers teardown across consecutive files sharing module state", async () => {
    const teardowns: Array<() => Promise<void>> = [];
    const closed: string[] = [];
    const makeScope = (label: string) => {
      const scope = new ArtifactResourceScope();
      scope.addCloseHook(async () => {
        closed.push(label);
      });
      return scope;
    };

    await withReusableJavaScriptScopeForTest(async () => "file-a-1", {
      testPath: "/suite/fileA.test.ts",
      registerTeardown: (fn) => teardowns.push(fn),
      createScope: () => makeScope("A"),
    });
    await withReusableJavaScriptScopeForTest(async () => "file-a-2", {
      testPath: "/suite/fileA.test.ts",
      registerTeardown: (fn) => teardowns.push(fn),
      createScope: () => makeScope("A-unexpected"),
    });
    expect(teardowns).toHaveLength(1);
    await teardowns[0]!();
    expect(closed).toEqual(["A"]);

    await withReusableJavaScriptScopeForTest(async () => "file-b-1", {
      testPath: "/suite/fileB.test.ts",
      registerTeardown: (fn) => teardowns.push(fn),
      createScope: () => makeScope("B"),
    });
    expect(teardowns).toHaveLength(2);
    await teardowns[1]!();
    expect(closed).toEqual(["A", "B"]);
  });

  it("retains a scope whose close failed and blocks replacement until retry succeeds", async () => {
    const teardowns: Array<() => Promise<void>> = [];
    let allowClose = false;
    let closeAttempts = 0;
    let created = 0;
    const createScope = () => {
      created += 1;
      const scope = new ArtifactResourceScope();
      scope.addCloseHook(async () => {
        closeAttempts += 1;
        if (!allowClose) throw new Error("injected close failure");
      });
      return scope;
    };

    await expect(
      withReusableJavaScriptScopeForTest(
        async () => {
          throw new Error("primary analysis failure");
        },
        {
          testPath: "/suite/retry.test.ts",
          registerTeardown: (fn) => teardowns.push(fn),
          createScope,
        },
      ),
    ).rejects.toThrow("primary analysis failure");
    expect(created).toBe(1);
    expect(closeAttempts).toBe(1);

    // Next call must retry the retained failed scope before creating a new one.
    await expect(
      withReusableJavaScriptScopeForTest(async () => "blocked", {
        testPath: "/suite/retry.test.ts",
        registerTeardown: (fn) => teardowns.push(fn),
        createScope,
      }),
    ).rejects.toThrow("injected close failure");
    expect(created).toBe(1);
    expect(closeAttempts).toBe(2);

    allowClose = true;
    const recovered = await withReusableJavaScriptScopeForTest(
      async () => "recovered",
      {
        testPath: "/suite/retry.test.ts",
        registerTeardown: (fn) => teardowns.push(fn),
        createScope,
      },
    );
    expect(recovered).toBe("recovered");
    expect(created).toBe(2);
    expect(closeAttempts).toBe(3);

    await teardowns[0]!();
    expect(closeAttempts).toBe(4);
  });
});

describe("runSettledConcurrent", () => {
  it("waits for started workers to finish and stops taking new items on failure", async () => {
    const events: string[] = [];
    let inFlightFinished = false;
    await expect(
      runSettledConcurrent([1, 2, 3, 4], 2, async (item) => {
        events.push(`start:${String(item)}`);
        if (item === 1) {
          throw new Error("first worker failed");
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
        inFlightFinished = true;
        events.push(`done:${String(item)}`);
      }),
    ).rejects.toThrow("first worker failed");
    expect(inFlightFinished).toBe(true);
    expect(events).toEqual(["start:1", "start:2", "done:2"]);
  });
});
