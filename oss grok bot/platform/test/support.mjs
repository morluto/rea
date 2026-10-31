import http from 'node:http';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
export async function syntheticProvider(port = 0) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(input);
    const messages = input.messages ?? [];
    const text = JSON.stringify(messages);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'synthetic-workflow', choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    chunk({ role: 'assistant' });
    if (text.includes('MILESTONE_TEST')) {
      if (!messages.some((m) => m.role === 'tool')) {
        chunk({ content: 'I’ll check the synthetic source and prepare the report.' });
        chunk(
          {
            tool_calls: [
              {
                index: 0,
                id: 'source-check',
                type: 'function',
                function: {
                  name: 'memory_search',
                  arguments: JSON.stringify({ query: 'Synthetic source' }),
                },
              },
            ],
          },
          'tool_calls',
        );
      } else if (
        !messages.some((m) => m.role === 'tool' && m.tool_call_id === 'milestone-report')
      ) {
        chunk({ content: 'Routine fixture note that should stay inside activity.' });
        chunk(
          {
            tool_calls: [
              {
                index: 0,
                id: 'milestone-report',
                type: 'function',
                function: {
                  name: 'report_progress',
                  arguments: JSON.stringify({ message: 'Synthetic source check complete.' }),
                },
              },
              {
                index: 1,
                id: 'milestone-file',
                type: 'function',
                function: {
                  name: 'library_publish',
                  arguments: JSON.stringify({
                    name: 'milestone-report.txt',
                    mediaType: 'text/plain',
                    content: 'Synthetic milestone report.',
                  }),
                },
              },
            ],
          },
          'tool_calls',
        );
      } else {
        chunk({ content: 'The synthetic report' });
        await new Promise((r) => setTimeout(r, 250));
        chunk({ content: ' is ready.' }, 'stop');
      }
      res.end('data: [DONE]\n\n');
      return;
    }
    if (text.includes('MARKDOWN_TEST')) {
      chunk(
        {
          content:
            '## Synthetic Markdown\n\n**Readable** output.\n\n```js\nconst answer = 42;\n```\n\n<img src="x" onerror="document.body.dataset.unsafe=1">\n[unsafe](javascript:alert(1))',
        },
        'stop',
      );
      res.end('data: [DONE]\n\n');
      return;
    }
    if (text.includes('WAIT_TEST') && !messages.some((m) => m.role === 'tool')) {
      chunk(
        {
          tool_calls: [
            {
              index: 0,
              id: 'question-call',
              type: 'function',
              function: {
                name: 'ask_user',
                arguments: JSON.stringify({
                  question: 'Which synthetic format?',
                  choices: ['Brief', 'Detailed'],
                }),
              },
            },
          ],
        },
        'tool_calls',
      );
      res.end('data: [DONE]\n\n');
      return;
    }
    if (text.includes('DELEGATE_TEST') && !messages.some((m) => m.role === 'tool')) {
      const target = text.match(/TARGET=([a-f0-9-]{36})/)?.[1];
      chunk(
        {
          tool_calls: [
            {
              index: 0,
              id: 'delegate-call',
              type: 'function',
              function: {
                name: 'delegate_task',
                arguments: JSON.stringify({
                  targetBotId: target,
                  objective: 'Produce a concise synthetic worker result.',
                  allowedCapabilities: ['library'],
                  maxTurns: 3,
                }),
              },
            },
          ],
        },
        'tool_calls',
      );
      res.end('data: [DONE]\n\n');
      return;
    }
    if (text.includes('EXTENSION_TEST') && !messages.some((m) => m.role === 'tool')) {
      const remote = input.tools?.find((t) => t.function?.name.startsWith('ext_'));
      if (remote) {
        chunk(
          {
            tool_calls: [
              {
                index: 0,
                id: 'external-call',
                type: 'function',
                function: {
                  name: remote.function.name,
                  arguments: JSON.stringify({ text: 'synthetic-echo' }),
                },
              },
            ],
          },
          'tool_calls',
        );
        res.end('data: [DONE]\n\n');
        return;
      }
    }
    if (text.includes('CANCEL_TEST')) {
      chunk({ content: 'Synthetic long-running response started.' });
      const timer = setInterval(() => chunk({ content: '.' }), 100);
      req.on('close', () => clearInterval(timer));
      res.on('close', () => clearInterval(timer));
      return;
    }
    if (text.includes('APPROVAL_TEST') && !messages.some((m) => m.role === 'tool')) {
      chunk(
        {
          tool_calls: [
            {
              index: 0,
              id: 'routine-call',
              type: 'function',
              function: {
                name: 'routine_create',
                arguments: JSON.stringify({
                  name: 'Synthetic approved routine',
                  task: 'Report synthetic status',
                  cron: '0 9 * * 1-5',
                  timezone: 'America/Toronto',
                }),
              },
            },
          ],
        },
        'tool_calls',
      );
    } else if (text.includes('WORKFLOW_TEST') && !messages.some((m) => m.role === 'tool')) {
      chunk({
        content: 'Synthetic test: saving a scoped preference and publishing real test bytes.',
      });
      chunk(
        {
          tool_calls: [
            {
              index: 0,
              id: 'memory-call',
              type: 'function',
              function: {
                name: 'memory_save',
                arguments: JSON.stringify({
                  subject: 'Test preference',
                  content: 'Use concise synthetic reports.',
                  scope: 'bot',
                  source: 'Synthetic workflow request',
                  certainty: 'user_confirmed',
                }),
              },
            },
            {
              index: 1,
              id: 'artifact-call',
              type: 'function',
              function: {
                name: 'library_publish',
                arguments: JSON.stringify({
                  name: 'synthetic-report.txt',
                  mediaType: 'text/plain',
                  content: 'Synthetic workflow report\nVerified bytes, not research data.\n',
                }),
              },
            },
          ],
        },
        'tool_calls',
      );
    } else {
      chunk(
        {
          content: text.includes('WORKFLOW_TEST')
            ? 'Synthetic test completed. The host tool receipts establish the memory and artifact writes.'
            : 'OK — synthetic endpoint response.',
        },
        'stop',
      );
    }
    res.write(
      `data: ${JSON.stringify({ id: 'synthetic', choices: [], usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 } })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { server, port: server.address().port, requests };
}
export async function startHost(data, port) {
  const child = spawn(process.execPath, ['--experimental-sqlite', 'packages/host/src/server.mjs'], {
    cwd: resolve('.'),
    env: { ...process.env, WORKSHOP_DATA: data, WORKSHOP_PORT: String(port) },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (c) => (logs += c));
  child.stderr.on('data', (c) => (logs += c));
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const call = async (path, value, method = value === undefined ? 'GET' : 'POST') => {
    const response = await fetch(base + '/api' + path, {
      method,
      headers: {
        origin: base,
        ...(cookie ? { cookie } : {}),
        ...(value === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    if (response.headers.get('set-cookie'))
      cookie = response.headers.get('set-cookie').split(';')[0];
    const body = await response.json();
    return { status: response.status, body };
  };
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw Error(logs);
    // The spawned child's listen callback proves which process owns this URL.
    // Health from an unrelated listener must never establish fixture readiness.
    if (!logs.includes(`Orbit ${base} | data ${resolve(data)} | pid ${child.pid}`)) {
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }
    try {
      const health = await call('/health');
      if (health.status !== 200) throw Error('Fixture health failed');
      return { child, call, base, logs: () => logs, cookie: () => cookie };
    } catch {
      if (child.exitCode !== null) throw Error(logs);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  child.kill();
  throw Error(`Host start timeout: ${logs}`);
}
export async function waitFor(fn, describe, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error(`Timeout: ${describe}`);
}
export async function stopHost(host) {
  if (host.child.exitCode !== null || host.child.signalCode !== null) return;
  host.child.kill('SIGTERM');
  await new Promise((resolve) => {
    if (host.child.exitCode !== null || host.child.signalCode !== null) return resolve();
    host.child.once('exit', resolve);
  });
}
