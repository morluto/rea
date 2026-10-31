# Orbit

A personal Bot workspace with an installable Electron desktop app, connected desktop/iPhone clients, and a local website. You define your Bots and bring your own model. One selected primary host owns their sessions, routines, memory, files and Linux computers.

This is an actively developed private prototype. The software does not include model credentials, preconfigured Bots or a model subscription. A feature's implementation is separate from real-provider verification.

## Install and use

The Windows build produces a per-user installer at `.local/releases/Orbit Setup 0.6.3.exe`. Install it, open **Orbit**, and choose **Use this computer as the primary host**. Installation does not require administrator access. The current prototype is unsigned; no signed release or automatic update service is claimed.

1. Create your local workspace account.
2. Open **Settings & models**. Choose **Sign in with ChatGPT** to authorize an eligible ChatGPT plan on OpenAI’s page, or configure your own endpoint/protocol/exact model ID and enter its API key only in the app’s private form. Run **Test actual response** to verify access to the selected model.
3. Create a Bot with a name, shape and color. It asks what you want it to do, and that answer becomes its job.
4. Send a prompt. The acknowledgement, meaningful milestones and final answer appear in the session. Routine steps and tool receipts sit in expandable Activity; approvals and questions remain directly actionable. Inspect Memory, Knowledge, Library, Routines, Queue and Activity for the underlying records.
5. Open Computer. With a working Linux Docker engine, choose **Prepare Linux image** once on the primary host, then start this Bot’s computer.

Closing the desktop window keeps a primary host running in the tray, including routines. **Quit Orbit** drains/stops its app-owned host. A remote client can quit without stopping its primary host. Turning off or sleeping the primary computer prevents execution; no cloud worker is implied.

## One-time reminders and alerts

"Remind me in one minute" is a one-time reminder, not an every-minute routine. Bots with the Routines permission can use reminder_create; the host delivers once without calling the model again. The reminder appears in its original conversation and Notifications. Workspace tools > Notifications also offers Remind me once and cancellation.

Enable desktop alerts in Notifications and use Send test notification. Windows and Mac show a system banner, and the iPhone app shows a local banner while it is open. Banners are only for an approval, a question, or a reminder. Task progress stays in the chat. Keep the primary app running; closing its window is supported, but quitting or sleeping the host delays execution. Pending reminders catch up once after restart. OS submission does not prove a visible banner: Do Not Disturb and system settings can suppress it. There is no cloud push service.

## T3 coding handoffs

Workspace tools > T3 coding configures the installed T3 CLI and one Git project folder named orbit. Choose its base branch and optionally an explicit T3 provider instance/model pair. Grant each Bot the T3 coding capability. Each task starts a separate T3 thread and managed worktree under that shared project, on a branch keyed by Bot and task identity. No T3 login credentials are imported.

Inspect or follow up through the coding panel. T3 owns execution, questions and permissions. Orbit Stop does not stop these independent threads; use T3 to stop them. The primary host watches Orbit-created tasks and returns terminal results to the originating chat with a durable notification. Results are T3 reports, not independent verification. Orbit follow-ups reopen monitoring; direct external follow-ups after delivery do not. Unknown dispatch receipts must be reconciled, not blindly resubmitted. Backup restore disables the coding connection.

## Taught tasks, private vault and action rules

**Taught tasks** saves reusable instructions/checklists, revision history and an optional completed example from the same Bot. Runs use normal admission, model execution and permissions. Export includes instructions only. This is not browser recording or automatic workflow inference.

**Personal vault** stores owner-only login, contact and card details encrypted locally. Values require an explicit private reveal. Bots cannot access them. Metadata edits preserve private values. Website autofill, OS keychain and hardware approval are not implemented. Removal cannot securely erase existing backups or SQLite journals.

**Custom action rules** scopes Ask/Allow/Deny to a connection, exact named operation and selected Bots. Descriptions do not grant authority. Deny wins; account grants and capabilities still apply. Rule changes invalidate pending approvals.

**Search library** offers paged literal phrase search over exact current UTF-8 text revisions with digests and stable short-lived snapshots. Binary, invalid UTF-8 and oversized files are explicitly unsearched. Semantic search and PDF/Office extraction remain incomplete.

Native catalogs expose Gmail 27 tools, Google Calendar 6, Microsoft mail 14 and Microsoft Calendar 7. Existing connections explicitly choose **Custom action rules > Update available tools**. New tools default to Ask; existing named policies remain. Real account behavior requires verification.

## Play HTML artifacts

Known artifact links open the exact stored revision. Default interactive preview has no network access. For trusted HTML games, Play with CDN & mouse permits jsDelivr/unpkg scripts and pointer lock; Esc releases the mouse. Fullscreen is available. The sandbox retains an opaque origin, blocks parent/product API access, and has no native/tool bridge. This is executable generated code, not a guarantee that an arbitrary artifact is safe or functional.

## Connect any plugin

All 54 catalog entries share Connect / Enable, progress, success or explicit failure, and Options. The same interaction does not imply the same identity provider or a working adapter for every service:

- Google and Microsoft mail/calendar plugins open their own provider consent after one-time app registration. Orbit watches the result without a separate Test tools step.
- Hosted MCP presets start that server's OAuth flow. After consent completes, Orbit discovers the actual tools before reporting availability. Some providers require an approved client, a paid plan or different server configuration; failed discovery is not reported as connected.
- Custom MCP services ask for their real server URL and authentication method. Save & connect automatically signs in or checks tools. API keys are entered privately and kept in the encrypted vault. No-auth is an explicit option for a server that actually permits it, not an authentication bypass.
- Bundled instruction skills enable for the selected owned Bot without an external account. Options allows a different Bot selection or connection configuration.

The current owned Bot is the initial selection, not every Bot. Existing configured Bot selections are retained. Connection success does not bypass Connected apps capability, tool policies or approvals. Closing a pending sign-in cancels the local flow; a late token response cannot restore the cancelled local grant. Provider-side account or consent revocation remains separate.

Google login does not connect Slack, Drive, Slides or every other service. Catalog recipes without a hosted endpoint still require an actual compatible MCP server; no fake adapters or preconnected accounts are supplied.

## Google plugin sign-in

Open Workspace tools > Plugins > Connect Google beside Gmail or Google Calendar. Once the provider app is registered, that button starts account consent in the system browser; Orbit watches the result automatically. It reports the selected account and available tools after verified identity, or an explicit failed/cancelled/expired state. If a browser blocks automatic opening, use Open Google sign-in in the dialog. Closing the dialog cancels that attempt.

For this bring-your-own-client prototype, the first connection needs a one-time Google Cloud Desktop app OAuth registration. Enable the required Gmail/Calendar APIs, configure consent and any required test users, then import the downloaded Desktop client JSON in Orbit's private setup form. Do not import service-account keys, Web app client files, account passwords or someone else's credentials. The client secret is encrypted locally, never returned by setup/status responses, and reused for future plugin setup through separately owned connection credentials. The Google Desktop loopback callback uses the primary host's root URL; legacy explicitly configured Web clients retain their original callback path. Registration setup is restricted to the primary-local workspace owner.

Saving app setup automatically advances to sign-in; no second plugin setup/test step is required. Gmail and Calendar still have separate account grants and consent scopes. The current owned Bot is selected on first connect; other Bots are not granted access automatically. Bots need Connected apps permission and tool approval policies remain unchanged. Other plugins retain their own provider/MCP requirements: Google login does not connect every service. No bundled developer-owned OAuth client or completed real Google authorization is claimed.

## Install on a Mac

There is no built, signed or verified Mac installer in this Windows environment. The desktop source includes a Mac packaging target; these are build instructions, not a claim of an executed Apple build.

1. Transfer `.local/releases/Orbit Source 0.6.3.zip` or the current standalone source folder to the Mac and extract it. Do not copy Windows node_modules, runtime .local data, credential vaults or the Windows installer. Older exported source ZIPs or the private repository may lack current local changes; check package.json for version 0.6.3. `python scripts/export-source.py` regenerates an inspected source ZIP from explicit source roots.
2. Use Node 24.22.1 and npm 11.16.0, then open Terminal in the folder containing this README and package.json.
3. Run the commands below. The first three launch from source; the last builds the requested Mac disk image/ZIP into .local/releases.

~~~sh
npm ci
node node_modules/electron/install.js
npm run desktop
# Run separately when ready to create the installer:
npm run desktop:package:mac
~~~

If packaging succeeds, open the generated DMG and copy Orbit to Applications. Signing/notarization is not configured or verified here; do not disable system-wide security protections to run an untrusted download. Running from source is available without claiming a signed distribution. This is the Electron desktop app; Xcode is needed for the separate iOS project, not stated here as a requirement for running the desktop source.

To see your existing Windows Bots rather than an empty new Mac host, choose Connect to primary host on the Mac. On Windows, use Workspace tools > Primary host, enable a reachable private-network/VPN HTTPS connection, verify its fingerprint on the Mac and use Pair another device's one-use code. Sign into your existing workspace account. Do not use 127.0.0.1 or localhost for the Windows address from the Mac: those refer to the Mac itself. Both machines need a route to each other and Windows Orbit must remain running. Provider consent still starts on the primary computer. The exact pairing and trust steps follow below.

## Connect your Mac or iPhone to Windows

Your Windows computer can remain the primary host. Other apps control its existing sessions and Docker computers; they do not create new copies on each device.

On the primary app, open **Workspace tools → Primary host**. Select a reachable private-network/VPN address and enable the private connection. The app creates an encrypted HTTPS identity and shows its fingerprint. Choose **Pair another device** to create an expiring, one-use code.

On the other app, enter the displayed HTTPS address. Compare the complete fingerprint with the Windows app before trusting it. Enter the one-use pairing code, then sign in to your workspace account. The app saves its selected host and device session; access can be revoked from the primary host. Advanced settings also accept your own trusted PEM certificate/key.

Both devices need a real route to the primary host. A LAN or existing private VPN works; the app does not configure a router, firewall, VPN, public tunnel or cloud relay. Browser clients need a certificate they already trust. Native clients support explicit fingerprint verification without installing a global certificate exception.

The iOS client source/project is included. Compiling, signing and running it requires macOS, Xcode 26+ and an appropriate Apple signing setup. Capacitor 8 targets iOS 15+. It does not run Docker or the Pi host on the phone. No signed iOS/macOS download is offered until those builds are produced and verified.

## Monorepo

| Owner | Responsibility |
|---|---|
| `apps/desktop` | Electron window/tray/menu, host selection, native trust confirmation, owned host startup/shutdown, Windows/macOS packaging |
| `apps/workspace` | Shared workspace interface, onboarding, sessions, original animated mascots, file previews and product controls |
| `apps/mobile` | Capacitor iOS project, bundled host selector and isolated remote WKWebView |
| `apps/website` | Local website, shared mascot preview and actual build-download availability |
| `packages/host` | API, authentication, SQLite, Pi sessions, scheduler, permissions, connector/device/computer coordination, HTTPS pairing |
| `computer` | Linux desktop image and authenticated broker |
| `device` | Explicitly paired, scoped Python file/HTTP companion |
| `scripts` / `test` | Startup, backup restore, package checks and synthetic/optional live verification |

The website and apps share the same original interface assets. The remote workspace is served by its selected primary, so it uses the host's current UI and contracts.

## Develop locally

Pinned tooling: Node 24.22.1, npm 11.16.0. Dependencies and overrides are locked; do not upgrade unrelated host runtimes.

```sh
npm ci
node node_modules/electron/install.js
npm run desktop
```

The explicit Electron install step downloads only this application's pinned desktop runtime. The packaged app needs neither npm nor a separate Node installation.

```sh
npm start                  # loopback host + shared workspace, port 4317
npm run website            # loopback site, port 4318
npm run desktop:package    # per-user Windows NSIS installer
npm run desktop:package:mac # macOS packaging; run on a Mac
npm run mobile:sync        # build bundled client assets and sync iOS project
npm run ios --workspace @bot-workshop/mobile # open Xcode, on a Mac
```

On Windows, `powershell -ExecutionPolicy Bypass -File scripts/start.ps1` uses the project-local pinned Node executable and protects its data-directory ACL. `scripts/desktop.mjs` removes inherited Node/Electron launch overrides before starting the app.

Host variables: `WORKSHOP_DATA` (data root), `WORKSHOP_PORT` (default 4317), `WORKSHOP_DOCKER_BIN` (explicit Docker CLI). Desktop development equivalents: `WORKSHOP_DESKTOP_DATA`, `WORKSHOP_DESKTOP_PORT`, `WORKSHOP_DESKTOP_PROFILE`. Packaged default data remains in the per-user `Bot Workshop` application-data directory, under `workspace/`, preserving earlier workspaces across the Orbit display-name change. Standalone development defaults to `.local/`. Keep these roots separate unless deliberately moving the primary.

An OS lifetime lock permits one host per data root. A second process is rejected before opening the database or recovering runs; changing its port does not bypass ownership. Never copy an active SQLite database manually.

## CLI engine recovery (source candidate)

The current source candidate adds **Start Linux engine** to Computer on the Windows primary host for the workspace owner. When `docker-cli.json` in the workspace data root names a WSL distro, or `WORKSHOP_DOCKER_DISTRO` is set, Orbit calls that distro’s Docker CLI (`wsl.exe -d <distro> -u root -- docker`) and starts it with `service docker start`. Otherwise it runs the already-installed `docker desktop start --timeout 20`. Either way it then checks the actual Linux daemon. An accepted start command does not establish readiness. It does not install Docker, reset WSL, restart unrelated workloads or remove volumes.

`docker login` is the user’s registry authorization flow; it does not start or repair the Linux engine. Orbit never imports those login credentials. Its public image preparation continues to use isolated, empty registry authentication.

## Persistent Bot computers

A computer is a Linux **container, not a full VM**. Docker Desktop may host many of these containers inside one Linux VM. Each Bot owns labeled generation-specific home/browser and workspace volumes. The broker exposes an authenticated desktop/browser; agent commands execute in separate workspace-only job containers with no desktop/home secret mounts or ambient host access.

```sh
docker info
docker build -t bot-workshop-desktop:0.2 computer
```

The recipe pins Debian bookworm-slim's linux/amd64 digest and websockify 0.13.0; apt package versions are not fully frozen. It uses Xvfb, Fluxbox, Chromium, x11vnc and noVNC. No privileged containers, host Docker socket, ambient secrets or unrelated home-directory mounts are used.

Start/Pause/Stop preserves declared volumes. Idle policies can pause then stop unused computers. Human takeover prevents agent input/capture/jobs; handback requires reobservation. Resource identity and generation are checked before actions, and failed cleanup remains owned/retryable. Snapshot captures stopped home/browser/workspace filesystem bytes, not RAM or a full VM. Restore creates new volumes/generation and retains old resources. Reset starts a fresh generation; image update snapshots and restores the old filesystem using the locally built image. Explicit removal validates owned resources and retains failed cleanup for retry. Saved snapshots/backups remain separate.

**Current Windows infrastructure limitation:** Docker Desktop is installed but the existing WSL instance fails new launches with `Wsl/Service/WSAENOBUFS`. A working engine and image have not been established. Administrator service repair is pending; no distro or disk data was deleted. Do not describe the desktop, authenticated viewer, Linux commands or snapshots as verified until the opt-in real-Docker check passes.

The Computer panel prepares its bundled recipe from the installed app; a source checkout is not required. Preparation copies only the declared recipe into the app’s data directory, uses an empty registry-auth configuration, displays bounded build output, and records verified image identity or an explicit failure. Stopping the build client does not promise that Docker discarded remote build work/cache. Existing Bot volumes are not replaced by preparing an image. The infrastructure observation is timestamped and coalesced for five seconds; viewer readiness requires an actual WebSocket/RFB response rather than socket-file presence. These paths still require real-Docker verification.

## Product behavior and verification boundaries

Implemented backend paths include user-defined Bots/models; Pi streaming/canonical history; durable admission/queue/cancellation/approvals/questions; scoped memory; immutable library revisions and sandboxed HTML outputs; routines/DST; scheduled connector actions; knowledge proposals/review; bounded child-Bot delegation; actual StreamableHTTP MCP and explicit HTTP tools; Google/Microsoft OAuth adapters; signed triggers; scoped device pairing/routing; local invitations/sharing/teams/rooms; notifications/usage; backups and new-root restore.

These have synthetic or local-protocol fixture coverage. No real model, Google/Microsoft account or remote device account is seeded. API configuration is not a verified connection, and a provider response is not proof of downstream delivery. Connector tools keep named contracts, selected account/operation identity, approvals and effect receipts.

The Plugins manager includes 54 app/skill recipes. Ten recipes include reviewed official MCP endpoint presets; mail/calendar use explicit Google/Microsoft OAuth application setup; Docs Canvas and PR Review Canvas are original bundled instruction skills. Other entries explicitly require a user-supplied MCP server. Catalog availability does not establish a working service adapter, an approved OAuth client, or a connected account. Figma remote access requires provider client approval. Configuration/update, selected-Bot grants, discovery/testing and local removal are implemented. Updating replaces the connection, so re-enter required credentials, sign in again and review tool permissions. Removing forgets local credentials/grants while retaining prior receipts; already submitted provider effects may still finish. MCP discovery is currently bounded to 64 tools per connection; use a narrower server where needed. No external accounts are preconnected.

MCP OAuth uses the pinned SDK for metadata discovery, PKCE, client registration and refresh. Sign-in starts on the primary computer. The encrypted vault owns only credentials explicitly provided to this app; callbacks are one-use and generation-bound. Local protocol fixtures establish these paths; real service OAuth policy/client acceptance remains unverified.

Chat uses the configured worker model through Pi with reasoning off. The host durably accepts the task before work starts, streams small text deltas, and records model-authored milestones separately from ordinary activity. It does not invoke an additional fast acknowledgement model. The canonical history and complete host events remain available when expanding activity; milestone text is a Bot update, not independent proof of an external effect.

ChatGPT plan sign-in uses Pi 1.4.0’s supported OpenAI provider OAuth flow: a primary-local callback, PKCE, stable installation host ID and explicit Orbit registration. The host stores only credentials obtained through this app’s own authorization flow in its encrypted vault; it never imports Codex, browser or other app login stores. Cancel/disconnect and token refresh share a generation-checked credential owner. Choose the account on OpenAI’s page; the app does not claim to verify its email or import ChatGPT conversations. A saved OAuth grant is distinct from a completed model response. The installed Pi catalog supplies exact model choices, not account entitlement guarantees. Sign-in requires the primary computer; port 1455 must be available. An optional private callback-URL field handles a browser redirect that does not reach the primary. Local account setup remains separate from provider authorization. Restoring a backup to a new root creates a new agent-host identity, so the restored ChatGPT connection forgets its old local grant and requires a new sign-in; the original workspace is unchanged.

The supported Responses transport sends complete local context with `store:false`, streaming and local tool declarations. Protocol fixtures cover the actual Pi transport, OAuth listener/state rejection/cancellation, isolated persistence and refresh/revocation. A real subscription sign-in and model reply still need the user to complete authorization. Usage shares the chosen plan’s limits. See [official ChatGPT plan integration](https://developers.openai.com/siwc/token-sharing-open-source) and [current route limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

The Pi SDK owns the sole canonical conversation history. Host projections retain entry/run identity; they do not create a second model transcript. The host owns scheduling, acceptance, policy and receipts. Explicit resource loading disables ambient context, default host shell/filesystem tools and provider-login discovery. Agents receive the original platform prompt, their user-defined role, one run mode, enabled supplements and relevant scoped context.

Still incomplete: full live-model/provider conformance; rich binary extraction/semantic search; full retention/paging/compaction/cost reservation; sandboxed executable plugin runtime and MCP Apps; full settings/organization depth; native push/audio pipelines; signed updater; Apple builds/device validation. These remain targets, not hidden working integrations. The real Docker lifecycle check has now passed locally; inspect the status ledger for the exact viewer and installed-app verification scope.

## Validation

```sh
npm test
node --experimental-sqlite scripts/browser-check.mjs
node scripts/experience-check.mjs
node scripts/model-signin-check.mjs
npm run desktop:check
node scripts/site-check.mjs # website must be running
node scripts/package-check.mjs
```

The backend suite has **49 scenarios: 48 pass and one opt-in real-Docker scenario**. It covers actual host/Pi synthetic HTTP flows and real local MCP/Python/HTTPS fixture transports. The separate explicitly enabled real-Docker scenario passed on this host. Computer coordinator fixtures alone do not certify Docker.

Browser checks use a fresh isolated installed Edge profile on Windows, or Playwright Chromium elsewhere. Native checks launch the real Electron application, test its isolated renderer and Pi tool flow, verify close/background/Quit/restart, then connect a separate fingerprint-confirmed desktop client to the same primary host. They use temporary synthetic data and an explicitly synthetic model endpoint.

To test the packaged Windows executable:

```powershell
$env:WORKSHOP_PACKAGED_EXE = (Resolve-Path '.local/releases/win-unpacked/Bot Workshop.exe').Path
npm run desktop:check
node scripts/progress-check.mjs
```

Both packaged workflows use isolated temporary workspaces, not production accounts. Desktop checks cover full Quit/restart, reminders and remote pairing; progress checks cover taught tasks, private vault, action rules, library search and coding-result return.

Build against frozen sources; do not mutate packaged inputs while the archive is being written. Inspect the package with `scripts/package-check.mjs` before running/distributing it. Runtime audit output and screenshots/results stay in ignored `.local/verification/`. Performance metrics reported by the browser workflow cover the host only; no full process-family or before/after superiority claim.

With a working Linux engine and image, explicitly opt into the real computer lifecycle test:

```powershell
$env:WORKSHOP_DOCKER_TEST = '1'
node --experimental-sqlite --test test/computer.live.test.mjs
node --experimental-sqlite scripts/computer-ui-check.mjs
```

It creates labeled test-owned resources and exercises desktop capture, input leases, detached-job cleanup/cancel, pause, snapshot and restore. Inspect any retained cleanup failure; never delete unrelated Docker resources or volumes.

The UI check starts a separate temporary host and actual Linux desktop, verifies the authenticated viewer survives background refreshes, then exercises human control and handback. It removes only its own computer resources. noVNC uses the official v1.6.0 browser-module source, pinned to commit `a8dfd6a3ea3c74244f5ebdaa5a7f1023007a7820` with lockfile integrity. The registry build contains converted CommonJS modules unsuitable for direct browser loading. `scripts/package-check.mjs` compares every packaged runtime file with the current source and checks the browser dependency's entrypoint.

## Data, backup and shutdown

Passwords use scrypt, sessions are hashed, secrets are AES-256-GCM encrypted with a separate local vault key. Protect the data root and its backups as your workspace. Native Windows startup applies current-user data ACLs. This is local filesystem protection, not an OS-keychain or hosted multi-tenant security claim.

Create a verified product backup in **Backups & app**. It includes SQLite, canonical sessions, immutable artifacts, vault/key and completed computer snapshot archives; it does not automatically copy running Docker volumes or companion workspaces. Inspect/restore to a new root:

```sh
node scripts/restore.mjs inspect BACKUP_DIRECTORY
node scripts/restore.mjs restore BACKUP_DIRECTORY NEW_DATA_ROOT
```

Restore never overwrites an existing directory or adopts original live Docker resources. Schedules/triggers/network exposure are paused, sessions expire, paired devices/clients are revoked, and computers receive new ownership identities. Reenable execution and pair clients deliberately.

Desktop Quit and authenticated **Stop host** drain loaded work; crash recovery records interrupted/unknown effects without automatically replaying external actions. Docker volume deletion is not part of app shutdown.

## Official implementation references

[Electron utility processes](https://www.electronjs.org/docs/latest/api/utility-process), [renderer security](https://www.electronjs.org/docs/latest/tutorial/security), [Capacitor iOS](https://capacitorjs.com/docs/ios), [Docker Windows setup](https://docs.docker.com/desktop/setup/install/windows-install/), [Docker volume persistence](https://docs.docker.com/engine/storage/volumes/). Installed SDK sources/documentation and the exact lockfile govern version-specific APIs.

## Record a synthetic native preview

```sh
npx playwright install ffmpeg # set PLAYWRIGHT_BROWSERS_PATH=.local/playwright first
npm run showcase:preview
```

The workflow opens the real Electron app with a fresh temporary profile, uses the real host/Pi path with a synthetic endpoint, and records onboarding, model configuration/check, Bot creation, prompt/tool output, cancellation/mascots, memory, exact Library bytes, visible milestones/expandable activity, plugin setup, routines, actual computer setup state and settings. It writes a captioned H.264 1920×1080 MP4, raw recording and chapter/evidence JSON under ignored `.local/showcase/`. `ffmpeg-static` 5.3.0 is a development-only encoder dependency, never a bundled product runtime. No production profile or provider credentials are read. The persistent synthetic-preview label is intentional: this draft cannot certify a real provider or functioning computer. A final real-model/computer walkthrough remains pending their verification.
