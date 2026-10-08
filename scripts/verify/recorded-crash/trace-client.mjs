import { connectRecordedCrash } from "./public.mjs";

const session = await connectRecordedCrash({
  entrypoint: process.argv[2],
  environment: process.env,
});
try {
  await session.inspect("mcp", process.argv[3], { debuggerContext: true });
} finally {
  await session.close();
}
