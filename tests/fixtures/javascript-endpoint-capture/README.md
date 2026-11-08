# Static endpoint and capture fixture

This source-owned loopback application was recorded on Linux with Playwright
1.64.1 and Chromium headless shell 153.0.8010.12. `recording.har.txt` is the original
HAR 1.2 from `browser.newContext({recordHar: {mode: "full", content: "embed"}})`;
its SHA-256 is `f0e7d2c869c811d4272a7b2916c6531c8c6cc7938336a35575e2a6b7b6346714`.
The `.txt` suffix preserves the recorder bytes without JSON formatting; the test
copies it to `capture.har` before production decoding.
The recorded origin is `http://127.0.0.1:42845`. Do not reserialize the HAR.

The server returned the two adjacent text files as `/app.js` and `/`, and JSON
for the API paths. It streamed each response in two chunks 40 ms apart. The
browser awaited all three fetch response bodies before context close. The five
recorded requests are `/`, `/app.js`, `/api/users?ordinary=kept-source-only`,
`/users/123` and `/observed-only`. The script's unused function bodies were
never called. Transport authentication headers and cookies are absent.

The public acceptance test copies these sources into a temporary application
and runs the production static analyzer, HAR decoder, comparison and retained
views through CLI/MCP. It replays this recording offline and needs no browser
or network. The recording proves only this small application's selected run.
