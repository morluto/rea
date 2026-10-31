import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const file = 'synthetic-thread.json';
const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
const option = (name) => args[args.indexOf(name) + 1];
if (args[1] === 'list')
  console.log(
    JSON.stringify(
      state ? [{ threadId: state.threadId, title: state.title, status: state.status }] : [],
    ),
  );
else if (args[1] === 'start') {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const thread = {
    threadId: 'synthetic-thread',
    projectId: 'synthetic-project',
    title: option('--title'),
    branch: option('--branch'),
    worktreePath: process.cwd(),
    status: 'completed',
    input,
  };
  writeFileSync(file, JSON.stringify(thread));
  console.log(JSON.stringify({ threadId: thread.threadId, projectId: thread.projectId }));
} else if (args[1] === 'show')
  console.log(
    JSON.stringify({
      thread: state,
      messages: [{ role: 'assistant', text: 'Synthetic coding result.' }],
    }),
  );
else if (args[1] === 'send') {
  for await (const chunk of process.stdin) {
  }
  console.log(JSON.stringify({ threadId: state.threadId, accepted: true }));
} else process.exitCode = 1;
