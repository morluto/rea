/** Largest accepted session message, including the encoded command result. */
export const MAX_CLI_SESSION_FRAME_BYTES: number;

/** Length-prefixed JSON frame shared by the session parent and worker. */
export function encodeCliSessionFrame(value: unknown): Buffer;

/**
 * Parse complete frames from a byte stream. An oversized or malformed frame
 * fails the reader instead of resynchronizing on a later length. Call finish
 * at EOF to require the stream to end on a frame boundary.
 */
export function createCliSessionFrameReader(
  onFrame: (value: unknown) => void,
): {
  (chunk: Buffer | string): void;
  finish(): void;
};
