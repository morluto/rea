/** Write one JSON line and wait for stdout to accept it. */
export const writeWorkerControlFrame = (
  value: unknown,
  limit: number,
  limitMessage: string,
): Promise<void> => {
  const frame = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(frame) > limit) throw new RangeError(limitMessage);
  return new Promise<void>((resolve, reject) => {
    process.stdout.write(frame, (error) =>
      error === null || error === undefined ? resolve() : reject(error),
    );
  });
};
