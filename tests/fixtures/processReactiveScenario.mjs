import { spawn, spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

import { WebSocket } from "ws";

process.stdout.write("Ready\n");
const worker = spawn(
  process.execPath,
  ["-e", 'process.title = "rea-reactive-worker"; setTimeout(() => {}, 750);'],
  { stdio: "ignore" },
);
process.stdout.write("Collecting\n");
spawnSync(process.argv[2], ["probe"], { stdio: "ignore" });
await writeFile("reactive-result.txt", "created");
await fetch(`${process.env.REA_REPLAY_HTTP_URL}/reactive`);
await new Promise((resolve, reject) => {
  const socket = new WebSocket(process.env.REA_REPLAY_WEBSOCKET_URL);
  socket.once("open", () => socket.send("reactive-client"));
  socket.once("message", () => socket.close());
  socket.once("close", resolve);
  socket.once("error", reject);
});
await new Promise((resolve, reject) => {
  worker.once("exit", resolve);
  worker.once("error", reject);
});
