import type { VerifierFixture } from "./verifier-fixture.mjs";

/**
 * Release the commands, then remove the run root, or keep it with
 * `keepFixtures`; unconfirmed commands retain the root. Copied authentication
 * is removed independently of both.
 */
export function closeAgentEvaluation(options: {
  readonly fixture: VerifierFixture;
  readonly commands: { close(): Promise<void> };
  readonly authPath: string;
  readonly keepFixtures: boolean;
}): Promise<void>;
