/** Remove copied authentication independently; retain ordinary files until commands release. */
export function closeAgentEvaluation(options: {
  readonly commands: { close(): Promise<void> };
  readonly authPath: string;
  readonly evaluationRoot: string;
  readonly keepFixtures: boolean;
}): Promise<void>;
