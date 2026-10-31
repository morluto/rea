import { openSettings } from '../test/ui.mjs';
// A repeatable native recording with isolated synthetic data. No production profile,
// vault, browser cookies, credentials or research is read by this workflow.
import ffmpeg from 'ffmpeg-static';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { syntheticProvider } from '../test/support.mjs';
import { version } from '../packages/host/src/version.mjs';

if (!process.argv.includes('--synthetic-preview'))
  throw Error(
    'Pass --synthetic-preview. A final real-provider/computer walkthrough requires separate verified footage.',
  );
const exec = promisify(execFile);
const folder = resolve('.local/showcase', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(folder, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'bot-workshop-showcase-'));
const provider = await syntheticProvider();
const env = Object.fromEntries(
  [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'HOME',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
    'TEMP',
    'TMP',
  ]
    .filter((k) => process.env[k])
    .map((k) => [k, process.env[k]]),
);
Object.assign(env, {
  WORKSHOP_DESKTOP_PROFILE: profile,
  WORKSHOP_DESKTOP_DATA: join(profile, 'workspace'),
  WORKSHOP_DESKTOP_PORT: '0',
  PLAYWRIGHT_BROWSERS_PATH: resolve('.local/playwright'),
});
// Playwright's recorder binary is project-local too; no global runtime install.
process.env.PLAYWRIGHT_BROWSERS_PATH = env.PLAYWRIGHT_BROWSERS_PATH;
const { _electron: electron } = await import('playwright');
let app, page, video, start;
const chapters = [],
  errors = [];
const hold = (ms = 1800) => page.waitForTimeout(ms);
async function chapter(title, detail) {
  chapters.push({ startMs: Date.now() - start, title, detail });
  console.log(title);
  await hold(650);
}
async function closeDialog() {
  await page.getByRole('button', { name: 'Close', exact: true }).click();
}
async function type(label, text) {
  const target = page.getByLabel(label, { exact: true });
  await target.fill('');
  await target.pressSequentially(text, { delay: 28 });
}
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
try {
  app = await electron.launch({
    ...(process.env.WORKSHOP_PACKAGED_EXE
      ? {
          executablePath: process.env.WORKSHOP_PACKAGED_EXE,
          args: ['-r', resolve('node_modules/playwright-core/lib/server/electron/loader.js')],
        }
      : { args: ['apps/desktop/main.mjs'] }),
    cwd: resolve('.'),
    env,
    timeout: 30000,
    recordVideo: { dir: join(folder, 'raw'), size: { width: 1280, height: 800 }, fps: 30 },
  });
  start = Date.now();
  page = await app.firstWindow();
  video = page.video();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => errors.push(e.message));
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1280, 800),
  );
  await chapter(
    '01 / Open the desktop app',
    'A fresh native profile. Windows is the primary execution host.',
  );
  await hold(2500);
  await page.getByRole('button', { name: 'Use this computer as the primary host' }).click();
  await page.getByRole('heading', { name: 'Create your workspace' }).waitFor({ timeout: 40000 });
  await chapter(
    '02 / Create a private workspace',
    'Test-only account; password is masked. No personal data is loaded.',
  );
  await type('Account name', 'Showcase');
  await page.getByLabel('Password (at least 12 characters)').fill('Synthetic-showcase-only-2026');
  await hold(1200);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('heading', { name: 'Create a Bot.', exact: false }).waitFor();
  await hold(2400);
  await chapter(
    '03 / Configure and verify a model',
    'This preview uses a local synthetic endpoint through the real Pi SDK.',
  );
  await openSettings(page);
  await page.getByRole('button', { name: 'Configure a model' }).click();
  await type('Configuration name', 'Synthetic preview endpoint');
  await page.getByLabel('Base URL', { exact: false }).fill(`http://127.0.0.1:${provider.port}/v1`);
  await type('Exact model ID', 'synthetic-workflow');
  await hold(2500);
  await page.getByRole('button', { name: 'Save configuration' }).click();
  await openSettings(page);
  await page.getByRole('button', { name: 'Test actual response' }).click();
  await page.getByText('Connection: verified', { exact: false }).waitFor();
  await hold(2200);
  await closeDialog();
  await chapter(
    '04 / Give a Bot its own role',
    'User-defined identity, model and explicit capabilities.',
  );
  await page.getByRole('button', { name: 'Create your first Bot' }).click();
  await type('Name', 'Atlas');
  await hold(1200);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('button', { name: 'Choose a model', exact: true }).click();
  await page
    .getByLabel('Model configuration')
    .selectOption({ label: 'Synthetic preview endpoint · synthetic-workflow (verified)' });
  await hold(800);
  await page.getByRole('button', { name: 'Publish revision', exact: true }).click();
  await chapter(
    '05 / First prompt and real tool receipts',
    'Synthetic model output; actual scoped memory and versioned file writes.',
  );
  await type(
    'Message',
    'WORKFLOW_TEST: remember that I prefer concise reports, then publish a test report.',
  );
  await hold(1500);
  await page.getByRole('button', { name: 'Send ↑' }).click();
  await page
    .getByText(
      'Synthetic test completed. The host tool receipts establish the memory and artifact writes.',
      { exact: false },
    )
    .waitFor();
  await hold(4200);
  await chapter(
    '06 / Watch progress; stop a task',
    'The working mascot reflects an active stream. Cancellation stops the run.',
  );
  await page.getByRole('button', { name: 'New conversation', exact: false }).click();
  await type('Message', 'CANCEL_TEST: show a cancellable synthetic stream.');
  await page.getByRole('button', { name: 'Send ↑' }).click();
  await page.locator('#header [data-mascot-state="working"]').waitFor();
  await hold(10000);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.locator('#header [data-mascot-state="idle"]').waitFor();
  await hold(2000);
  await chapter(
    '07 / Memory and versioned Library',
    'Inspect the preference and exact file bytes created by host tools.',
  );
  await page.getByRole('button', { name: 'Memory', exact: true }).click();
  await page.getByRole('heading', { name: 'Test preference' }).waitFor();
  await hold(2800);
  await page.getByRole('tab', { name: 'Library', exact: true }).click();
  await page.getByRole('button', { name: 'synthetic-report.txt', exact: true }).click();
  await page.getByText('Verified bytes, not research data.', { exact: false }).waitFor();
  await hold(3500);
  await closeDialog();
  await chapter(
    '08 / Milestones without the noise',
    'First reply, meaningful update, final answer. Expand activity for routine steps.',
  );
  await page.getByRole('button', { name: 'Conversation', exact: true }).click();
  await page.getByRole('button', { name: 'New conversation', exact: false }).click();
  await type('Message', 'MILESTONE_TEST: check the fixture source and publish a report.');
  await page.getByRole('button', { name: 'Send ↑' }).click();
  await page.getByText('The synthetic report is ready.', { exact: true }).waitFor();
  await page.getByText('Synthetic source check complete.', { exact: true }).waitFor();
  await hold(3200);
  await page.locator('.run-activity > summary').click();
  await hold(2500);
  await page.locator('.run-activity > summary').click();
  await chapter(
    '09 / Plugins, selected by you',
    'Plugin recipes need account setup; no service is preconnected.',
  );
  await page.locator('.tools-disclosure > summary').evaluate((node) => node.click());
  await page.getByRole('button', { name: 'Plugins', exact: true }).click();
  await page.locator('.plugin-row').first().waitFor();
  await hold(2800);
  await page.getByLabel('Search plugins').fill('Notion');
  await page.locator('.plugin-row:visible').getByRole('button', { name: 'Set up' }).click();
  await hold(2800);
  await closeDialog();
  await chapter(
    '10 / Durable routines',
    'Saved on the primary host. This test schedule is paused after creation.',
  );
  await page.getByRole('button', { name: 'Routines', exact: true }).click();
  await page.locator('#addroutine').click();
  await type('Name', 'Daily preview check-in');
  await page
    .getByLabel('Task', { exact: true })
    .fill('Summarize the work in this Bot and ask what to do next.');
  await page.getByLabel('IANA timezone').fill('America/Toronto');
  await hold(2800);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await hold(2200);
  await chapter(
    '11 / Each Bot has a Linux computer',
    'Docker is unavailable here. This is the actual setup state, not a live desktop.',
  );
  await page.getByRole('button', { name: 'Computer', exact: true }).click();
  await page.getByRole('heading', { name: 'Linux engine unavailable' }).waitFor({ timeout: 30000 });
  await hold(3800);
  await page.getByText('Computer settings', { exact: true }).click();
  await page.getByRole('button', { name: 'Idle policy', exact: true }).click();
  await hold(2800);
  await closeDialog();
  await chapter(
    '12 / Primary host and settings',
    'Other clients use this host. Integrations need their own explicit configuration.',
  );
  await page.getByRole('button', { name: 'Backups & app', exact: true }).click();
  await page.getByRole('heading', { name: 'Desktop app', exact: false }).waitFor();
  await hold(3200);
  await closeDialog();
  await openSettings(page);
  await hold(3000);
  await page.locator('select[name="theme"]').selectOption('dark');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await hold(2300);
  await page.getByRole('button', { name: 'Conversation', exact: true }).click();
  await chapter(
    'Preview complete / Verification still ahead',
    'Real provider, Linux engine and Apple builds remain pending.',
  );
  await hold(3500);
  assert.deepEqual(errors, []);
  const metrics = await page.evaluate(() => fetch('/api/metrics').then((r) => r.json()));
  assert.equal(metrics.activeRuns, 0);
  const end = Date.now() - start;
  const closed = app.waitForEvent('close');
  await app.evaluate(({ app }) => app.quit());
  await closed;
  app = null;
  const raw = join(folder, 'native-preview.webm');
  await video.saveAs(raw);
  const fontFolder = join(folder, 'fonts');
  mkdirSync(fontFolder);
  copyFileSync('apps/workspace/fonts/InstrumentSans.ttf', join(fontFolder, 'InstrumentSans.ttf'));
  const time = (ms) => {
    const s = Math.max(0, ms) / 1000;
    return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}`;
  };
  const safe = (s) => s.replace(/[{}\\\r\n]/g, ' ');
  const events = [
    `Dialogue: 0,0:00:00.00,${time(end + 3000)},Header,,0,0,0,,Orbit  /  Native Windows app`,
    `Dialogue: 0,0:00:00.00,${time(end + 3000)},Preview,,0,0,0,,SYNTHETIC PREVIEW — NO REAL PROVIDER`,
  ];
  chapters.forEach((c, i) =>
    events.push(
      `Dialogue: 0,${time(c.startMs)},${time(chapters[i + 1]?.startMs ?? end + 3000)},Caption,,0,0,0,,${safe(c.title)}  •  ${safe(c.detail)}`,
    ),
  );
  writeFileSync(
    join(folder, 'chapters.ass'),
    `[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Header,Instrument Sans,25,&H003F3932,&H00000000,&H00F8F4EE,&H00F8F4EE,0,0,0,0,100,100,0,0,1,0,0,7,192,100,17,1\nStyle: Preview,Instrument Sans,22,&H00204083,&H00000000,&H00F8F4EE,&H00F8F4EE,-1,0,0,0,100,100,0,0,1,0,0,9,50,192,19,1\nStyle: Caption,Instrument Sans,23,&H003F3932,&H00000000,&H00F8F4EE,&H00F8F4EE,0,0,0,0,100,100,0,0,1,0,0,2,100,100,16,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.join('\n')}\n`,
  );
  console.log('Encoding H.264 MP4…');
  await exec(
    ffmpeg,
    [
      '-hide_banner',
      '-y',
      '-i',
      'native-preview.webm',
      '-vf',
      'scale=1536:960,pad=1920:1080:192:60:color=0xf8f4ee,ass=chapters.ass:fontsdir=fonts',
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-r',
      '30',
      '-an',
      '-movflags',
      '+faststart',
      'Orbit - Synthetic Preview.mp4',
    ],
    { cwd: folder, windowsHide: true, timeout: 180000, maxBuffer: 2 * 1024 * 1024 },
  );
  const output = join(folder, 'Orbit - Synthetic Preview.mp4');
  const result = {
    at: new Date().toISOString(),
    version,
    mode: 'synthetic preview',
    application: process.env.WORKSHOP_PACKAGED_EXE ? 'packaged Electron' : 'source Electron',
    output,
    sha256: await digest(output),
    ffmpegSha256: await digest(ffmpeg),
    recordedMs: end,
    providerRequests: provider.requests.length,
    errors,
    metrics,
    chapters,
    unverified: [
      'real model provider',
      'Linux Docker engine, computer and viewer',
      'macOS build',
      'iOS native build/device',
    ],
  };
  writeFileSync(join(folder, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ output, recordedMs: end, chapters: chapters.length, errors }));
} finally {
  if (app) {
    try {
      await app.evaluate(({ app }) => app.quit());
    } catch {}
  }
  await new Promise((resolve) => provider.server.close(resolve));
}
