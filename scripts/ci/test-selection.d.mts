export type TestSelectionPlan =
  | {
      readonly version: 2;
      readonly mode: "full";
      readonly reason: string;
      readonly groups: readonly [];
    }
  | {
      readonly version: 2;
      readonly mode: "selected";
      readonly reason: string;
      readonly groups: readonly (readonly string[])[];
    };
export function planTestSelection(request: {
  readonly files: readonly string[];
  readonly event: string;
  readonly tier: string;
  readonly code: boolean;
  readonly snapshot: {
    readonly list: () => readonly string[];
    readonly read: (paths: readonly string[]) => ReadonlyMap<string, string>;
  };
}): TestSelectionPlan;
export function parseTestSelection(value: unknown): TestSelectionPlan;
export function testShards(tier: string, plan: TestSelectionPlan): string[];
