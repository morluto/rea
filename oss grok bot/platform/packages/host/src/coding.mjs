import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, isAbsolute } from 'node:path';
import { z } from 'zod';
import { Type } from '@earendil-works/pi-ai';
import { validate } from './product.mjs';
import { fail, id, callNonce } from './store.mjs';

const execute = promisify(execFile);
const text = z.string().trim().min(1);
export const CodingInput = z
  .object({
    title: text.max(120),
    task: text.max(32000),
    nonce: z.string().uuid(),
    conversationId: z.string().uuid().optional(),
  })
  .strict();
const ConfigInput = z
  .object({
    enabled: z.boolean(),
    executable: text.max(2000),
    entrypoint: z.string().max(2000).default(''),
    projectRoot: text.max(2000),
    baseRef: text.max(200).refine((value) => !value.startsWith('-')),
    provider: z.string().max(200).default(''),
    model: z.string().max(200).default(''),
  })
  .strict();
const Thread = z
  .object({
    threadId: text,
    projectId: text,
    title: z.string(),
    status: z.string(),
    branch: z.string().nullable().optional(),
    worktreePath: z.string().nullable().optional(),
  })
  .passthrough();
const ThreadList = z.array(
  z.object({ threadId: text, title: z.string(), status: z.string() }).passthrough(),
);

export class Coding {
  constructor(store, invoke) {
    this.store = store;
    this.controller = new AbortController();
    this.monitoring = null;
    this.stopped = false;
    this.invoke =
      invoke ??
      (async (config, args, input) => {
        try {
          const pending = execute(
            config.executable,
            [...(config.entrypoint ? [config.entrypoint] : []), ...args],
            {
              cwd: config.projectRoot,
              env: { ...process.env, ...(config.entrypoint ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
              windowsHide: true,
              timeout: 60000,
              signal: this.controller.signal,
              maxBuffer: 2 * 1024 * 1024,
            },
          );
          pending.child.stdin.on('error', () => {});
          pending.child.stdin.end(input ?? '');
          return JSON.parse((await pending).stdout);
        } catch {
          fail(
            'coding_transport',
            'T3 CLI did not return a confirmed receipt. Inspect T3 before retrying.',
            502,
          );
        }
      });
  }
  defaults() {
    const install = join(process.env.LOCALAPPDATA ?? homedir(), 'Programs', 't3code');
    return {
      enabled: false,
      executable: process.platform === 'win32' ? join(install, 'T3 Code (Nightly).exe') : 't3',
      entrypoint:
        process.platform === 'win32'
          ? join(install, 'resources', 'server.asar', 'apps', 'server', 'dist', 'bin.mjs')
          : '',
      projectRoot: join(homedir(), '.t3', 'projects', 'orbit'),
      baseRef: 'master',
      provider: '',
      model: '',
    };
  }
  config() {
    return this.store.list('coding_config')[0] ?? this.defaults();
  }
  installation() {
    return this.store.get('installation', 'installation').value;
  }
  async configure(ownerId, input) {
    const value = validate(ConfigInput, input);
    if (!!value.provider !== !!value.model)
      fail('invalid_input', 'Set both the T3 provider instance and model, or leave both blank');
    if (!isAbsolute(value.projectRoot) || !existsSync(value.projectRoot))
      fail('invalid_input', 'Select the existing local orbit project folder');
    value.projectRoot = realpathSync(value.projectRoot);
    if (basename(value.projectRoot).toLowerCase() !== 'orbit')
      fail('invalid_input', 'Coding is restricted to the shared orbit project');
    const archive = value.entrypoint.match(/^(.*\.asar)[\\/]/i)?.[1];
    if (
      value.entrypoint &&
      (!isAbsolute(value.executable) ||
        !existsSync(value.executable) ||
        !(existsSync(value.entrypoint) || (archive && existsSync(archive))))
    )
      fail('invalid_input', 'The configured T3 executable and entrypoint must exist');
    if (value.enabled)
      validate(
        ThreadList,
        await this.invoke(value, ['thread', 'list', '--project', value.projectRoot, '--json']),
      );
    return this.store.put('coding_config', { id: 'coding-config', ownerId, ...value });
  }
  requireBot(botId) {
    const bot = this.store.get(botId, 'bot');
    if (bot.retired || !bot.capabilities.includes('coding'))
      fail('not_authorized', 'Enable T3 coding in this Bot permissions first', 403);
    const config = this.config();
    if (!config.enabled)
      fail('unavailable', 'Configure and enable the local T3 coding connection first', 409);
    return config;
  }
  list(botId) {
    return this.store.list('coding_task', botId).slice(-30).reverse();
  }
  owned(botId, key) {
    const task = this.store.get(key, 'coding_task');
    if (task.botId !== botId) fail('not_authorized', 'Coding task belongs to another Bot', 403);
    return task;
  }
  async start(botId, input, sourceRun = null) {
    const value = validate(CodingInput, input),
      config = this.requireBot(botId);
    const prior = this.store.list('coding_task', botId).find((task) => task.nonce === value.nonce);
    if (prior) {
      if (
        prior.title !== value.title ||
        prior.task !== value.task ||
        (value.conversationId !== undefined && prior.conversationId !== value.conversationId)
      )
        fail('nonce_conflict', 'This coding nonce was used for different input', 409);
      return prior;
    }
    const conversationId =
      value.conversationId ?? (sourceRun ? this.store.get(sourceRun, 'run').conversationId : null);
    if (conversationId && this.store.get(conversationId, 'conversation').botId !== botId)
      fail('not_authorized', 'Coding conversation belongs to another Bot', 403);
    const key = id();
    const task = this.store.put('coding_task', {
      id: key,
      botId,
      sourceRun,
      ...value,
      conversationId,
      cycle: 0,
      installation: this.installation(),
      projectRoot: config.projectRoot,
      branch: 'orbit/' + botId + '/' + key,
      threadTitle: 'Orbit ' + key + ': ' + value.title,
      state: 'dispatching',
      threadId: null,
    });
    this.store.event(botId, sourceRun, 'coding.dispatching', { taskId: key });
    const prompt = [
      'Coding task handed off by an Orbit Bot. Work only in this T3-managed worktree of the shared orbit project.',
      'Do not modify other Bot worktrees or read Orbit/T3 credentials, research or unrelated workspaces.',
      'No publishing, deployment, PR creation, external messages, or unrelated host installation is authorized.',
      'Return actual files changed, checks run, result and remaining blockers. T3 owns this thread and its execution.',
      'Bot: ' + botId,
      'Task: ' + key,
      '',
      value.task,
    ].join('\n');
    try {
      const reply = await this.invoke(
        config,
        [
          'thread',
          'start',
          '--title',
          task.threadTitle,
          '--worktree',
          config.baseRef,
          '--branch',
          task.branch,
          ...(config.provider ? ['--provider', config.provider, '--model', config.model] : []),
          '--json',
          config.projectRoot,
          '-',
        ],
        prompt,
      );
      const receipt = validate(z.object({ threadId: text, projectId: text }).passthrough(), reply);
      this.store.put('coding_task', {
        ...task,
        threadId: receipt.threadId,
        projectId: receipt.projectId,
        state: 'accepted',
      });
      const observed = await this.invoke(config, [
        'thread',
        'show',
        '--messages',
        '0',
        '--json',
        receipt.threadId,
      ]);
      const thread = validate(Thread, observed.thread);
      if (
        thread.threadId !== receipt.threadId ||
        thread.projectId !== receipt.projectId ||
        (thread.branch !== task.branch && !(thread.status === 'preparing' && !thread.branch))
      )
        fail('coding_identity', 'T3 did not confirm the requested worktree branch', 502);
      return this.bind(task, thread);
    } catch (error) {
      this.store.put('coding_task', {
        ...this.store.get(key, 'coding_task'),
        state: 'unknown',
        reason: 'Dispatch was not confirmed. Refresh to reconcile; do not resubmit blindly.',
      });
      this.store.event(botId, sourceRun, 'coding.uncertain', { taskId: key });
      throw error;
    }
  }
  bind(task, thread) {
    const current = this.store.get(task.id, 'coding_task');
    const next = this.store.put('coding_task', {
      ...current,
      threadId: thread.threadId,
      projectId: thread.projectId,
      worktreePath: thread.worktreePath ?? null,
      state: thread.status,
      observedAt: Date.now(),
      reason: null,
    });
    this.store.event(task.botId, task.sourceRun, 'coding.observed', {
      taskId: task.id,
      threadId: next.threadId,
      state: next.state,
    });
    return next;
  }
  monitor(now = Date.now()) {
    if (this.stopped || this.monitoring || !this.config().enabled) return this.monitoring;
    const terminal = new Set(['completed', 'failed', 'interrupted', 'cancelled', 'rolled_back']);
    const task = this.store
      .list('coding_task')
      .find(
        (value) =>
          value.installation === this.installation() &&
          value.projectRoot === this.config().projectRoot &&
          (value.nextPollAt ?? 0) <= now &&
          (!terminal.has(value.state) || value.deliveredCycle !== (value.cycle ?? 0)) &&
          this.store.get(value.botId, 'bot').capabilities.includes('coding') &&
          !this.store.get(value.botId, 'bot').retired,
      );
    if (!task) return;
    this.store.put('coding_task', { ...task, nextPollAt: now + 15000 });
    this.monitoring = (async () => {
      try {
        const observed = await this.inspect(task.botId, task.id);
        if (this.stopped) return;
        const current = this.store.get(task.id, 'coding_task');
        if (
          current.cycle !== task.cycle ||
          !terminal.has(observed.task.state) ||
          current.deliveredCycle === (current.cycle ?? 0)
        )
          return;
        const final = observed.messages
          .filter(
            (value) =>
              value.role === 'assistant' && typeof value.text === 'string' && value.text.trim(),
          )
          .at(-1);
        if (observed.task.state === 'completed' && !final) {
          this.store.put('coding_task', {
            ...current,
            monitorError:
              'T3 is completed but no assistant result is available in recent messages.',
          });
          return;
        }
        const result = (
          final?.text ?? 'T3 reports ' + observed.task.state + '. Inspect its thread for details.'
        ).slice(0, 32000);
        const resultDigest = createHash('sha256')
          .update(JSON.stringify([final?.runId, result]))
          .digest('hex');
        if (
          current.resultDigest === resultDigest &&
          (current.cycle ?? 0) > (current.deliveredCycle ?? -1)
        )
          return;
        this.store.tx(() => {
          this.store.put('coding_task', {
            ...current,
            result,
            resultDigest,
            resultAt: now,
            deliveredCycle: current.cycle ?? 0,
            monitorError: null,
          });
          this.store.put('notification', {
            id: 'coding-' + task.id + '-' + (current.cycle ?? 0),
            botId: task.botId,
            ownerId: this.store.get(task.botId, 'bot').ownerId,
            kind: 'coding',
            title: 'Coding ' + observed.task.state + ': ' + task.title,
            message: result.slice(0, 1000),
            read: false,
          });
          this.store.event(task.botId, task.sourceRun, 'coding.result', {
            taskId: task.id,
            state: observed.task.state,
            conversationId: current.conversationId,
          });
        });
      } catch (error) {
        if (!this.stopped)
          this.store.put('coding_task', {
            ...this.store.get(task.id, 'coding_task'),
            nextPollAt: now + 60000,
            monitorError: error.message,
          });
      } finally {
        this.monitoring = null;
      }
    })();
    return this.monitoring;
  }
  async stop() {
    this.stopped = true;
    this.controller.abort();
    await this.monitoring;
  }
  async inspect(botId, key) {
    let task = this.owned(botId, key);
    const config = this.requireBot(botId);
    if (task.installation !== this.installation() || task.projectRoot !== config.projectRoot)
      fail(
        'coding_identity',
        'This task belongs to a previous installation or project; inspect it in T3',
        409,
      );
    if (!task.threadId) {
      const threads = validate(
        ThreadList,
        await this.invoke(config, ['thread', 'list', '--project', config.projectRoot, '--json']),
      );
      const matches = threads.filter((thread) => thread.title === task.threadTitle);
      if (matches.length !== 1)
        return {
          task,
          messages: [],
          limitation: 'No unique matching T3 receipt; no task was resubmitted.',
        };
      task = { ...task, threadId: matches[0].threadId };
    }
    const reply = await this.invoke(config, [
      'thread',
      'show',
      '--messages',
      '8',
      '--json',
      task.threadId,
    ]);
    const thread = validate(Thread, reply.thread);
    if (
      thread.threadId !== task.threadId ||
      (task.projectId && thread.projectId !== task.projectId) ||
      (thread.branch !== task.branch && !(thread.status === 'preparing' && !thread.branch))
    )
      fail('coding_identity', 'T3 thread identity changed', 409);
    task = this.bind(task, thread);
    const messages = validate(z.array(z.object({}).passthrough()), reply.messages);
    return {
      task,
      messages,
      limitation:
        'T3 reports execution state. Open T3 for permissions, questions, stop controls and complete history. Stopping an Orbit run does not stop this independent coding thread.',
    };
  }
  async send(botId, key, input) {
    const value = validate(
      z.object({ message: text.max(32000), nonce: z.string().uuid() }).strict(),
      input,
    );
    const { task } = await this.inspect(botId, key);
    if (!task.threadId)
      fail('coding_identity', 'Reconcile the original thread before sending follow-ups', 409);
    const prior = this.store
      .list('coding_message', botId)
      .find((message) => message.taskId === key && message.nonce === value.nonce);
    if (prior) return prior;
    const receipt = this.store.put('coding_message', {
      id: id(),
      botId,
      taskId: key,
      ...value,
      state: 'dispatching',
    });
    try {
      const reply = await this.invoke(
        this.requireBot(botId),
        ['thread', 'send', '--json', task.threadId, '-'],
        value.message,
      );
      this.store.put('coding_task', {
        ...this.store.get(key, 'coding_task'),
        state: 'accepted',
        cycle: (this.store.get(key, 'coding_task').cycle ?? 0) + 1,
        nextPollAt: 0,
        result: null,
        resultAt: null,
      });
      return this.store.put('coding_message', { ...receipt, state: 'accepted', receipt: reply });
    } catch (error) {
      this.store.put('coding_message', { ...receipt, state: 'unknown' });
      throw error;
    }
  }
  tools(run, tool) {
    return [
      tool(
        'coding_start',
        'coding',
        'Hand coding to T3 Code in the shared orbit project with a separate T3-managed worktree and thread. Use coding_status for results. Runs independently: stop it in T3, not with Orbit Stop.',
        Type.Object({
          title: Type.String({ minLength: 1, maxLength: 120 }),
          task: Type.String({ minLength: 1, maxLength: 32000 }),
        }),
        (args, _signal, callId) =>
          this.start(run.botId, { ...args, nonce: callNonce(run.id, callId) }, run.id),
        true,
      ),
      tool(
        'coding_list',
        'coding',
        'List this Bot coding handoffs and last observed states; use coding_status for fresh state.',
        Type.Object({}),
        () => this.list(run.botId),
      ),
      tool(
        'coding_status',
        'coding',
        'Read fresh T3 state and recent messages for a coding task owned by this Bot.',
        Type.Object({ taskId: Type.String() }),
        (args) => this.inspect(run.botId, args.taskId),
      ),
      tool(
        'coding_send',
        'coding',
        'Send a follow-up to this Bot T3 thread. A busy thread queues it; this does not interrupt or cancel work.',
        Type.Object({
          taskId: Type.String(),
          message: Type.String({ minLength: 1, maxLength: 32000 }),
        }),
        (args, _signal, callId) =>
          this.send(run.botId, args.taskId, {
            message: args.message,
            nonce: callNonce(run.id, callId),
          }),
        true,
      ),
    ];
  }
}
