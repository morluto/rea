# Fix Plan: Reuse Hopper GUI Windows Across REA Sessions for the Same Target

## Issue Summary

Currently each REA session creates a new Hopper document. The goal is to reuse existing Hopper GUI windows for the same target across REA sessions.

## Current Architecture Analysis

### Key Components

1. **`BinarySession.ts`** - Manages the active binary target and provider client lifecycle
2. **`HopperProvider.ts`** - Creates `HopperClient` instances for each target
3. **`HopperClient.ts`** - Owns a bridge session with authenticated NDJSON-over-Unix-socket
4. **`HopperCleanup.ts`** - Handles cleanup with `retainDocument` option
5. **`BridgeLauncher.ts` / `HopperApplicationLauncher.ts`** - Launches Hopper process and injects bridge
6. **`HopperTargetLease.ts`** - Prevents concurrent sessions from opening same target (socket-based lease)
7. **`shutdown.ts`** - Calls `session.close({ retainProviderDocuments: true })` on MCP shutdown

### Current Flow

1. User opens target → `BinarySession.open()` → `HopperProvider.createClient()` → `new HopperClient()` → `HopperClient.start()` → `HopperApplicationLauncher.launch()` → New Hopper document
2. Session closes → `BinarySession.close({ retainProviderDocuments: true })` → `HopperClient.close({ retainDocument: true })` → Sends `shutdown` (not `shutdown_document`) to bridge
3. New session opens same target → Creates entirely new `HopperClient` and launches new Hopper process/document

### Existing Reuse Mechanisms

- **Lease system** (`HopperTargetLease.ts`): Prevents _concurrent_ sessions for same target/profile using Unix socket locks
- **`retainDocument` option**: Tells Hopper bridge to detach (`shutdown`) rather than close document (`shutdown_document`)
- **`prepareHopperApplication`** (`BridgeLauncher.ts` lines 485-506): On macOS, checks if Hopper is already running and uses `open --hide --background` to avoid redundant launches

## Root Cause

The lease mechanism only prevents _concurrent_ access. When a session closes (even with `retainDocument: true`), the lease is released, allowing a new session to acquire it and launch a fresh Hopper process/document. There's no mechanism to:

1. Discover an existing Hopper bridge socket for a target
2. Connect to an existing authenticated bridge session
3. Preserve the lease across sessions for GUI reuse

## Fix Strategy

### Phase 1: Bridge Socket Discovery & Reconnection

**Files to modify:**

- `src/hopper/HopperClient.ts` - Add static method to discover existing bridge socket for a target
- `src/hopper/HopperSessionValues.ts` - Add utilities for socket path derivation from target identity

### Phase 2: Launcher Handoff Support

**Files to modify:**

- `src/hopper/BridgeLauncher.ts` - Modify `HopperApplicationLauncher` to support connecting to existing session
- `src/hopper/HopperTargetLease.ts` - Add "persistent lease" mode that survives session close

### Phase 3: Provider-Level Reuse Logic

**Files to modify:**

- `src/hopper/HopperProvider.ts` - Pass target identity to client; attempt reuse before creating new
- `src/application/binary/BinarySession.ts` - Track retained sessions and reuse clients when possible

### Phase 4: Cleanup Coordination

**Files to modify:**

- `src/hopper/HopperCleanup.ts` - Ensure retained documents don't leak resources
- `src/main/shutdown.ts` - Verify shutdown behavior with reuse enabled

---

## Detailed Changes

### 1. `src/hopper/HopperSessionValues.ts` - Add Socket Path Derivation

```typescript
// ADD: Derive deterministic socket path from target identity
export const deriveHopperSocketPath = (
  targetPath: string,
  targetKind: "executable" | "database",
  loaderArgs: readonly string[],
  runtimeRoot: string,
): string => {
  // Same hash logic as HopperTargetLease.acquireHopperTargetLease
  const key = createHash("sha256")
    .update(JSON.stringify({ targetPath, targetKind, loaderArgs }))
    .digest("hex")
    .slice(0, 32);
  return join(runtimeRoot, `${key}.sock`);
};

// ADD: Check if bridge socket exists and is responsive
export const probeHopperBridge = async (
  socketPath: string,
  expectedRunId: string,
  timeoutMs: number = 5000,
): Promise<Result<HopperServerInfo, HopperError>> => {
  // Connect and send health request with runId validation
};
```

### 2. `src/hopper/HopperClient.ts` - Add Reconnection Support

```typescript
// ADD: Static factory method to attempt reuse
static async tryReuseExistingSession(
  options: HopperClientOptions,
  targetIdentity: {
    targetPath: string;
    targetKind: "executable" | "database";
    loaderArgs: readonly string[];
  },
): Promise<HopperClient | null> {
  // 1. Derive expected socket path from target identity
  // 2. Probe existing bridge socket
  // 3. If responsive and runId matches (or we can re-authenticate), return existing client
  // 4. Otherwise return null to trigger new launch
}

// MODIFY: #start() to accept optional existing socket
async #start(
  signal?: AbortSignal,
  existingSocket?: Socket,
  existingRunId?: string,
): Promise<Result<HopperServerInfo, AnalysisError>> {
  // If existingSocket provided, skip launch and use existing connection
}

// MODIFY: Constructor to support pre-connected socket
constructor(options: HopperClientOptions, preconnected?: {
  socket: Socket;
  runId: string;
  token: string;
  runtimeRoot: string;
}) {
  // Initialize with pre-connected socket
}
```

### 3. `src/hopper/BridgeLauncher.ts` - Persistent Lease & Handoff

```typescript
// MODIFY: HopperApplicationLauncherOptions to include reuse mode
export interface HopperApplicationLauncherOptions {
  // ... existing fields
  readonly reuseMode?: "none" | "persistent-lease" | "handoff";
  readonly existingRunId?: string;
}

// MODIFY: #acquireLaunchLease to support persistent lease
async #acquireLaunchLease(
  runId: string,
  reuseMode: "none" | "persistent-lease" | "handoff" = "none",
): Promise<Result<HopperTargetLease | undefined, HopperStartError>> {
  if (reuseMode === "persistent-lease") {
    // Don't release lease on close; keep socket bound
    // Return lease with no-op release()
  }
  // ... existing logic
}

// MODIFY: #launchPreparedTarget to support handoff
async #launchPreparedTarget(input: {
  // ... existing fields
  readonly handoff?: boolean;
  readonly existingRunId?: string;
}) {
  if (input.handoff && input.existingRunId) {
    // Write bootstrap that tells bridge to re-authenticate with existing runId
    // Don't launch new process; just connect to existing bridge
  }
}
```

### 4. `src/hopper/HopperTargetLease.ts` - Persistent Lease Support

```typescript
// ADD: Persistent lease that survives process exit
export const acquirePersistentHopperTargetLease = async (input: {
  readonly targetPath: string;
  readonly targetKind: "executable" | "database";
  readonly loaderArgs: readonly string[];
  readonly runId: string;
}): Promise<HopperTargetLeaseAcquisition> => {
  // Similar to acquireHopperTargetLease but:
  // 1. Creates lease socket in persistent location (not temp)
  // 2. Lease release() is no-op (or delayed)
  // 3. Includes owner PID for stale detection
};

// ADD: Check if persistent lease exists and is valid
export const probePersistentLease = async (input: {
  readonly targetPath: string;
  readonly targetKind: "executable" | "database";
  readonly loaderArgs: readonly string[];
}): Promise<{ runId: string; processId: number } | null> => {
  // Connect to lease socket, read owner, verify process still alive
};
```

### 5. `src/hopper/HopperProvider.ts` - Reuse Logic in createClient

```typescript
createClient(
  target: BinaryTarget,
  profile?: AnalysisProfileCommitment,
  context?: AnalysisClientContext,
): AnalysisClient {
  // ... existing setup code ...

  // NEW: Attempt to reuse existing session
  const reuseContext = context?.reuseHopperSession;
  if (reuseContext) {
    const reusedClient = await HopperClient.tryReuseExistingSession(
      { launcher: applicationLauncher, ... },
      {
        targetPath: target.path,
        targetKind: target.kind,
        loaderArgs: derivedLoaderArgs.value,
      },
    );
    if (reusedClient) {
      return wrapClient(reusedClient); // Return analysis client wrapper
    }
  }

  // ... existing new client creation ...
}
```

### 6. `src/application/binary/BinarySession.ts` - Session Reuse Tracking

```typescript
// ADD: Track retained sessions by target identity
#retainedSessions = new Map<
  string, // target identity key
  {
    client: AnalysisClient;
    providerId: string;
    runId: string;
    targetPath: string;
    targetKind: "executable" | "database";
    loaderArgs: readonly string[];
  }
>();

// MODIFY: #closeActive to store retained session
async #closeActive(options): Promise<Result<null, AnalysisError>> {
  const previous = this.#active;
  this.#active = undefined;

  if (previous && options.retainProviderDocuments) {
    // Store for potential reuse instead of closing immediately
    const key = this.#targetIdentityKey(previous.target);
    this.#retainedSessions.set(key, {
      client: previous.client,
      providerId: previous.route.identity.id,
      runId: previous.runId,
      targetPath: previous.target.path,
      targetKind: previous.target.kind,
      loaderArgs: previous.route.profile?.parameters?.loaderArgs ?? [],
    });
    // Don't call #retireClient yet - defer until needed
    return ok(null);
  }

  // ... existing close logic ...
}

// MODIFY: #open to check for retained session
#open(resolve, options): Promise<Result<BinaryTarget, AnalysisError>> {
  // ... existing code ...

  const retained = sameTarget && sameProfile ? this.#active : undefined;

  // NEW: Check for retained session from previous close
  if (!retained) {
    const key = this.#targetIdentityKey(target);
    const retainedSession = this.#retainedSessions.get(key);
    if (retainedSession && await this.#retainedClientLive(retainedSession.client, options)) {
      // Reuse the retained session!
      this.#retainedSessions.delete(key);
      this.#active = {
        target,
        client: retainedSession.client,
        profile,
        route,
        runId: retainedSession.runId, // Reuse runId for continuity
      };
      // ... setup snapshot, etc.
      return ok(target);
    }
  }

  // ... existing new session creation ...
}

// ADD: Helper to create target identity key
#targetIdentityKey(target: BinaryTarget): string {
  return `${target.path}|${target.kind}|${this.#active?.route.profile?.parameters?.loaderArgs?.join(",") ?? ""}`;
}
```

### 7. `src/hopper/HopperCleanup.ts` - Retained Document Cleanup

```typescript
// MODIFY: cleanupHopperSession to handle deferred cleanup
export const cleanupHopperSession = async (
  input: HopperCleanupInput,
): Promise<Result<null, AnalysisError>> => {
  // If retainDocument is true, we may be deferring cleanup for reuse
  // Don't release lease or runtime root if we expect reuse

  const isDeferred =
    input.retainDocument &&
    input.resources.launch?.providerLifetime === "external-application";

  if (isDeferred) {
    // Only send shutdown (detach), don't release transport or runtime
    // Mark resources as "retained for reuse"
    return ok(null);
  }

  // ... existing full cleanup logic ...
};
```

### 8. `src/main/shutdown.ts` - Verify Shutdown Behavior

```typescript
// Current behavior is correct: retainProviderDocuments: true
// Just need to ensure it works with the new reuse mechanism
// No changes needed if BinarySession properly defers cleanup
```

---

## Implementation Priority

### Phase 1 (Core - Required for basic reuse)

1. `HopperSessionValues.ts` - Add socket path derivation and probe utilities
2. `HopperClient.ts` - Add `tryReuseExistingSession()` static method and pre-connected constructor
3. `HopperProvider.ts` - Integrate reuse attempt in `createClient()`
4. `BinarySession.ts` - Track retained sessions and reuse in `#open()`

### Phase 2 (Robustness - Lease persistence)

5. `HopperTargetLease.ts` - Add persistent lease acquisition
6. `BridgeLauncher.ts` - Support handoff mode and persistent lease

### Phase 3 (Cleanup - Resource management)

7. `HopperCleanup.ts` - Handle deferred cleanup for retained sessions
8. `shutdown.ts` - Verify integration

---

## Testing Strategy

### Unit Tests

- `HopperSessionValues.test.ts` - Test socket path derivation consistency
- `HopperClient.test.ts` - Test `tryReuseExistingSession()` with mock socket
- `HopperTargetLease.test.ts` - Test persistent lease acquisition/release
- `BinarySession.test.ts` - Test retained session reuse flow

### Integration Tests

- Open target → Close with retain → Reopen same target → Verify same Hopper window
- Concurrent sessions → Verify lease prevents conflicts
- Shutdown with retain → Restart MCP → Reopen → Verify reuse

### Manual Verification

1. Start REA MCP server
2. Open binary in Hopper via REA
3. Close REA session (or shutdown MCP)
4. Restart REA MCP server
5. Open same binary → Should reuse existing Hopper window

---

## Risk Assessment

| Risk                                         | Mitigation                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| Stale bridge sockets from crashed sessions   | Probe validates bridge responsiveness; stale detection via PID check                 |
| Lease conflicts between reuse and new launch | Persistent lease uses same socket path; acquisition fails if occupied                |
| Resource leaks from deferred cleanup         | Cleanup triggered on explicit close without retain, or on next reuse attempt         |
| RunId mismatch breaking authentication       | Bridge accepts re-authentication with new token for same runId; or we preserve runId |

---

## File Change Summary

| File                                      | Change Type | Description                                     |
| ----------------------------------------- | ----------- | ----------------------------------------------- |
| `src/hopper/HopperSessionValues.ts`       | Add         | Socket path derivation, bridge probe utility    |
| `src/hopper/HopperClient.ts`              | Modify      | Static reuse factory, pre-connected constructor |
| `src/hopper/HopperProvider.ts`            | Modify      | Pass reuse context to client creation           |
| `src/hopper/BridgeLauncher.ts`            | Modify      | Persistent lease support, handoff launch mode   |
| `src/hopper/HopperTargetLease.ts`         | Add         | Persistent lease acquisition and probing        |
| `src/application/binary/BinarySession.ts` | Modify      | Retained session tracking and reuse logic       |
| `src/hopper/HopperCleanup.ts`             | Modify      | Deferred cleanup for retained documents         |
| `src/main/shutdown.ts`                    | Verify      | Confirm integration works                       |

---

## Next Steps

1. Implement Phase 1 changes (core reuse mechanism)
2. Add unit tests for new utilities
3. Test integration with manual verification
4. Implement Phase 2 for robust lease persistence
5. Implement Phase 3 for cleanup coordination
6. Run full test suite and verify no regressions
