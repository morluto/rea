export declare const hasArmAttributes: (path: string) => Promise<boolean>;

export declare const neutralizeArmAttributes: (path: string) => Promise<void>;

export declare const removeArmAttributes: (
  candidates: readonly string[],
  execute: (
    command: string,
    args: readonly string[],
    options: { readonly timeout: number },
  ) => Promise<unknown>,
  path: string,
  options?: { readonly fallback?: boolean },
) => Promise<{
  readonly tool: string;
  readonly failures: readonly string[];
}>;
