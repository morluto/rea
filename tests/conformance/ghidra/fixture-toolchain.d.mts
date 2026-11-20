/** A host command a fixture runs, and the variable that selects another one. */
export interface FixtureTool {
  readonly variable?: string;
  readonly fallback: string;
}

export declare const FIXTURE_TOOLS: Readonly<Record<string, FixtureTool>>;

/** The command a fixture runs for `tool`. */
export declare function fixtureCommand(tool: FixtureTool): string;

/**
 * Refuse a lane before it allocates a workspace when this host lacks a
 * command its fixtures run, naming each missing capability.
 */
export declare function requireLaneToolchain(lane: string): Promise<void>;
