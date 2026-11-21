import { expect, it } from "vitest";
import { compareAndroidDeclarationFacts } from "./androidDeclarationComparison.js";
import {
  androidDeclarationFacts,
  androidDeclarationFactsFromManifest,
} from "../../../tests/fixtures/android/declarations.js";

it("compares selected declarations, keeps source coordinates, and omits unchanged groups", () => {
  const left = androidDeclarationFacts(`
    <activity android:name=".Main" android:exported="false"/>
    <service android:name=".Removed"/>
    <receiver android:name=".Stable" android:exported="false"/>`);
  const right = androidDeclarationFacts(`
    <activity android:name=".Main" android:exported="true" android:permission="example.permission.READ"/>
    <provider android:name=".Added" android:authorities="example.fixture.data"/>
    <receiver android:name=".Stable" android:exported="false"/>`);
  right.target_sdk = "36";
  right.permissions = [
    "android.permission.INTERNET",
    "android.permission.CAMERA",
  ];
  const report = compareAndroidDeclarationFacts(left, right);
  expect(report.sdk.target_sdk).toEqual({
    left: "35",
    right: "36",
    state: "changed",
  });
  expect(report.permissions).toMatchObject({
    coverage: "unknown",
    observed_only_right: ["android.permission.CAMERA"],
  });
  expect(report.components).toMatchObject({
    coverage: "complete-within-inputs",
    summary: { added: 1, removed: 1, changed: 1, unchanged: 1, unknown: 0 },
  });
  expect(report.components.changes).toHaveLength(3);
  expect(
    report.components.changes.find(({ kind }) => kind === "activity"),
  ).toMatchObject({
    name: "example.fixture.Main",
    state: "changed",
    fields: {
      exported: "changed",
      permission: "changed",
      authorities: "unchanged",
    },
    left: [
      {
        source_index: 0,
        declaration_index: 0,
        declared_name: ".Main",
        location: { line: 2 },
      },
    ],
  });
});

it("preserves permission provenance, exported defaults and unknown SDK without deriving effective policy", () => {
  const left = androidDeclarationFacts('<activity android:name=".Main"/>');
  const right = androidDeclarationFacts(
    '<activity android:name=".Main" android:exported="false"/>',
  );
  left.min_sdk = null;
  right.min_sdk = null;
  const report = compareAndroidDeclarationFacts(left, right);
  expect(report.sdk.min_sdk.state).toBe("unknown");
  expect(report.components.changes[0]).toMatchObject({
    state: "changed",
    fields: { exported: "changed" },
    left: [{ exported: null, exported_default: false }],
    right: [{ exported: false, exported_default: false }],
  });
  const inherited = androidDeclarationFacts('<service android:name=".Main"/>');
  const explicit = structuredClone(inherited);
  const a = inherited.components.items[0];
  const b = explicit.components.items[0];
  if (a === undefined || b === undefined)
    throw new Error("Missing fixture component");
  // A known inherited permission and an explicit equal spelling retain distinct provenance.
  inherited.components.items[0] = {
    ...a,
    permission: "example.READ",
    permission_source: "application",
  };
  explicit.components.items[0] = {
    ...b,
    permission: "example.READ",
    permission_source: "component",
  };
  expect(
    compareAndroidDeclarationFacts(inherited, explicit).components.changes[0]
      ?.fields?.permission,
  ).toBe("changed");
});

it("compares authorities as sets while preserving exact arrays, and keeps null distinct from empty", () => {
  const left = androidDeclarationFacts(
    '<provider android:name=".Data" android:authorities="a;b"/>',
  );
  const right = androidDeclarationFacts(
    '<provider android:name=".Data" android:authorities="b;a;a"/>',
  );
  expect(
    compareAndroidDeclarationFacts(left, right).components.summary.unchanged,
  ).toBe(1);
  const first = right.components.items[0];
  if (first === undefined) throw new Error("Missing provider");
  right.components.items[0] = { ...first, authorities: [] };
  const report = compareAndroidDeclarationFacts(left, right);
  expect(report.components.changes[0]).toMatchObject({
    state: "changed",
    left: [{ authorities: ["a", "b"] }],
    right: [{ authorities: [] }],
  });
  left.components.items[0] = { ...first, authorities: null };
  expect(
    compareAndroidDeclarationFacts(left, right).components.changes[0],
  ).toMatchObject({
    state: "unknown",
    fields: { authorities: "unknown" },
  });
});

it("retains every duplicate and never turns partial or unavailable inventories into absence", () => {
  const left = androidDeclarationFacts(
    '<activity android:name=".Same"/><activity android:name=".Same"/>',
  );
  const right = androidDeclarationFacts('<activity android:name=".Same"/>');
  const duplicate = compareAndroidDeclarationFacts(left, right).components;
  expect(duplicate.changes).toMatchObject([
    {
      state: "unknown",
      left: [{ source_index: 0 }, { source_index: 1 }],
      right: [{ source_index: 0 }],
      fields: null,
    },
  ]);
  for (const status of ["partial", "unavailable"] as const) {
    const incomplete = androidDeclarationFacts("");
    incomplete.components.status = status;
    const compared = compareAndroidDeclarationFacts(right, incomplete);
    expect(compared.components.changes[0]).toMatchObject({
      state: "unknown",
      right: [],
      fields: null,
    });
    expect(compared.components.summary.removed).toBe(0);
    expect(compared.components.coverage).toBe(
      status === "partial" ? "partial" : "unknown",
    );
    expect(
      compareAndroidDeclarationFacts(incomplete, right).components.summary
        .added,
    ).toBe(0);
  }
});

it("does not match different component kinds and marks unresolved attributes/declarations unknown", () => {
  const left = androidDeclarationFacts('<activity android:name=".Same"/>');
  const right = androidDeclarationFacts('<service android:name=".Same"/>');
  expect(
    compareAndroidDeclarationFacts(left, right).components.summary,
  ).toMatchObject({ added: 1, removed: 1, changed: 0 });
  const facts = androidDeclarationFacts();
  const first = facts.components.items[0];
  if (first === undefined) throw new Error("Missing component");
  facts.components.items[0] = {
    ...first,
    exported: null,
    exported_default: null,
    permission_source: "unknown",
  };
  expect(
    compareAndroidDeclarationFacts(facts, facts).components.changes[0],
  ).toMatchObject({
    state: "unknown",
    fields: { exported: "unknown", permission: "unknown" },
  });
  facts.components.items[0] = { ...first, declaration_coverage: "partial" };
  expect(
    compareAndroidDeclarationFacts(facts, facts).components.changes[0],
  ).toMatchObject({ state: "unknown", fields: null });
});

it.each([
  {
    name: "an unknown default against a known default",
    left: { exported: true, sdk: "FutureDessert", default: null },
    right: { exported: true, sdk: "35", default: false },
    state: "unknown",
    coverage: "partial",
  },
  {
    name: "unknown defaults on both sides",
    left: { exported: true, sdk: "FutureDessert", default: null },
    right: { exported: true, sdk: "FutureDessert", default: null },
    state: "unknown",
    coverage: "partial",
  },
  {
    name: "a known literal difference despite unknown defaults",
    left: { exported: true, sdk: "FutureDessert", default: null },
    right: { exported: false, sdk: "FutureDessert", default: null },
    state: "changed",
    coverage: "partial",
  },
  {
    name: "equal known literals and defaults",
    left: { exported: true, sdk: "35", default: false },
    right: { exported: true, sdk: "35", default: false },
    state: "unchanged",
    coverage: "complete-within-inputs",
  },
  {
    name: "a known default difference with equal literals",
    left: { exported: true, sdk: "16", default: true },
    right: { exported: true, sdk: "35", default: false },
    state: "changed",
    coverage: "complete-within-inputs",
  },
  {
    name: "an omitted declaration against an explicit equal default",
    left: { exported: undefined, sdk: "35", default: false },
    right: { exported: false, sdk: "35", default: false },
    state: "changed",
    coverage: "complete-within-inputs",
  },
] as const)(
  "compares producer export facts symmetrically: $name",
  ({ left, right, state, coverage }) => {
    const provider = (selection: {
      exported: boolean | undefined;
      sdk: string | null;
    }) => {
      const sdk =
        selection.sdk === null
          ? ""
          : `<uses-sdk android:targetSdkVersion="${selection.sdk}"/>`;
      const exported =
        selection.exported === undefined
          ? ""
          : ` android:exported="${String(selection.exported)}"`;
      const text = `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="example.fixture">${sdk}<application><provider android:name=".Data" android:authorities="example.fixture.data"${exported}/></application></manifest>`;
      return androidDeclarationFactsFromManifest(text, selection.sdk, null);
    };
    const a = provider(left);
    const b = provider(right);
    for (const [facts, selected] of [
      [a, left],
      [b, right],
    ] as const) {
      expect(facts.components.status).toBe("complete");
      expect(facts.components.items).toHaveLength(1);
      expect(facts.components.items[0]).toMatchObject({
        declaration_coverage: "complete",
        exported: selected.exported ?? null,
        exported_default: selected.default,
      });
    }
    for (const [l, r] of [
      [a, b],
      [b, a],
    ] as const) {
      const report = compareAndroidDeclarationFacts(l, r);
      expect(report.sdk.target_sdk).toMatchObject({
        left: l.target_sdk,
        right: r.target_sdk,
      });
      expect(report.components.coverage).toBe(coverage);
      expect(report.components.summary).toEqual({
        added: 0,
        removed: 0,
        changed: 0,
        unchanged: 0,
        unknown: 0,
        [state]: 1,
      });
      if (state === "unchanged") {
        expect(report.components.changes).toEqual([]);
      } else {
        expect(report.components.changes).toMatchObject([
          {
            state,
            fields: { exported: state },
            left: [
              {
                exported: l.components.items[0]?.exported,
                exported_default: l.components.items[0]?.exported_default,
              },
            ],
            right: [
              {
                exported: r.components.items[0]?.exported,
                exported_default: r.components.items[0]?.exported_default,
              },
            ],
          },
        ]);
        if (coverage === "partial")
          expect(report.components.changes[0]?.reason).toContain("unknown");
        else expect(report.components.changes[0]?.reason).toBeNull();
      }
    }
  },
);
