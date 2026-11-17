/** Output and status surfaces selected by the invocation's process owner. */
export interface CliServeOptions {
  readonly stdout?: ((text: string) => void) | undefined;
  readonly exit?: ((code: number) => void) | undefined;
  /** Retained for in-process callers; command environment is selected at composition. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

/** REA's flat command registry and its one-shot invocation boundary. */
export interface CliInstance {
  readonly name: string;
  serve(
    arguments_?: readonly string[],
    options?: CliServeOptions,
  ): Promise<void>;
}
