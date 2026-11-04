import { once } from "node:events";

// Preserve the real stdout write and its result, but hold its completion until
// the reader acknowledges receiving the whole document and closing the socket.
// This orders the close before a queued write without a timing-dependent sleep
// or a synthetic EPIPE. A completion callback is not proof the reader stayed open.
const readerClosed = once(process.stdin, "data");
const write = process.stdout._write;
process.stdout._write = function (chunk, encoding, callback) {
  write.call(this, chunk, encoding, (cause) => {
    if (cause) callback(cause);
    else void readerClosed.then(() => callback());
  });
};
