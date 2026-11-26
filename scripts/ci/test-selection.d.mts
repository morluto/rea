export type TestSelectionPlan =
  | {
      readonly version: 3;
      readonly mode: "full";
      readonly shadowFiles?: readonly string[];
      readonly reason: string;
    }
  | {
      readonly version: 3;
      readonly mode: "selected";
      readonly reason: string;
      readonly files: readonly string[];
      readonly shards: number;
    };
export type TestSelectionSnapshot = {
  readonly list: () => readonly string[];
  readonly read: (paths: readonly string[]) => ReadonlyMap<string, string>;
};
export type TestSelectionReason =
  | "changed"
  | "imports"
  | "built"
  | "beside"
  | "owner"
  | "names";
export function traceAffectedTests(request: {
  readonly files: readonly string[];
  readonly snapshot: TestSelectionSnapshot;
}): {
  readonly selected: ReadonlyMap<string, TestSelectionReason>;
  readonly untraced: readonly string[];
};
export function planTestSelection(request: {
  readonly files: readonly string[];
  readonly event: string;
  readonly tier: string;
  readonly code: boolean;
  readonly snapshot: TestSelectionSnapshot;
}): TestSelectionPlan;
export function parseTestSelection(value: unknown): TestSelectionPlan;
export function testShards(tier: string, plan: TestSelectionPlan): string[];
