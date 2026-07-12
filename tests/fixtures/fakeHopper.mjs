import { createServer } from "node:net";

const [socketPath, token] = process.argv.slice(2);
const server = createServer((socket) => {
  socket.on("error", () => undefined);
  socket.setEncoding("utf8");
  let buffer = "";
  const send = (message, fragmented = false) => {
    const line = `${JSON.stringify(message)}\n`;
    if (!fragmented) return socket.write(line);
    const midpoint = Math.floor(line.length / 2);
    socket.write(line.slice(0, midpoint));
    setTimeout(() => socket.write(line.slice(midpoint)), 2);
  };
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const request = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (request.token !== token) {
        send({ id: request.id, error: { code: -32001, message: "bad token" } });
      } else if (request.method === "health") {
        send(
          {
            id: request.id,
            result: { name: "REA Hopper bridge", version: "1.0.0" },
          },
          true,
        );
      } else if (request.method === "shutdown") {
        send({ id: request.id, result: { shutdown: true } });
        setTimeout(() => server.close(), 2);
      } else if (request.method === "hang") {
        // Deliberately leave the request pending.
      } else if (request.method === "exit") {
        process.exit(7);
      } else if (request.method === "malformed") {
        socket.write("{not-json}\n");
      } else if (request.method === "wrong_id") {
        send({ id: request.id + 100, result: {} });
      } else if (request.method === "remote_error") {
        send({
          id: request.id,
          error: { code: -32001, message: "safe fake failure" },
        });
      } else {
        const delay = request.params?.delay ?? 0;
        setTimeout(
          () => send({ id: request.id, result: request.params ?? {} }),
          delay,
        );
      }
      newline = buffer.indexOf("\n");
    }
  });
});

server.listen(socketPath);
process.on("SIGTERM", () => server.close());
