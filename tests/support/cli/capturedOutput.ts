import { Writable } from "node:stream";

export const captureOutput = (terminal = false) => {
  const chunks: Buffer[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  if (terminal) Object.defineProperty(destination, "isTTY", { value: true });
  return {
    destination,
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
};
