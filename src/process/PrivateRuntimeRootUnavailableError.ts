/** Expected failure when a runtime root's privacy boundary is unavailable. */
export class PrivateRuntimeRootUnavailableError extends Error {
  readonly code = "private-runtime-root-authority-unavailable";
  readonly retryable: boolean;

  constructor(
    message: string,
    options?: ErrorOptions & { readonly retryable?: boolean },
  ) {
    super(message, options);
    this.name = "PrivateRuntimeRootUnavailableError";
    this.retryable = options?.retryable ?? false;
  }
}
