//@category REA Verification

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import generic.jar.ResourceFile;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileOptions;
import ghidra.app.decompiler.DecompileProcess.DisposeState;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.app.script.GhidraScriptUtil;
import ghidra.app.util.headless.HeadlessAnalyzer;
import ghidra.app.util.headless.HeadlessScript;
import ghidra.framework.Application;
import ghidra.program.model.listing.Function;
import ghidra.util.UndefinedFunction;
import ghidra.util.task.TaskMonitor;
import java.io.File;
import java.lang.reflect.Field;
import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Future;

/**
 * Replaces the bridge decompiler after real import and analysis so one procedure's
 * decompilation fails. Verifies that analyze_function still returns the listing-backed
 * facts. This injection does not establish which natural inputs make Ghidra fail.
 */
public class ReaDecompilerFailureProbe extends GhidraScript {
    private static final String INJECTED = "Injected backend failure";
    private static final List<String> LISTING_FACETS = List.of(
        "assembly", "comments", "callers", "callees", "incoming_references",
        "outgoing_references", "referenced_strings", "referenced_names", "basic_blocks",
        "unresolved_calls");
    private final JsonArray checks = new JsonArray();

    private void require(String name, boolean condition) {
        if (!condition) throw new IllegalStateException("Decompiler failure assertion failed: " + name);
        checks.add(name);
    }

    private Function exportedFunction(String name) {
        Function selected = null;
        for (Function f : currentProgram.getFunctionManager().getFunctions(true)) {
            if (!f.isThunk() && (f.getName().equals(name) || f.getName().equals("_" + name)) &&
                currentProgram.getSymbolTable().isExternalEntryPoint(f.getEntryPoint())) {
                if (selected != null) throw new IllegalStateException("Ambiguous fixture export " + name);
                selected = f;
            }
        }
        if (selected == null) throw new IllegalStateException("Missing fixture export " + name);
        return selected;
    }

    private GhidraScript script(String name, File expected) throws Exception {
        ResourceFile source = GhidraScriptUtil.findScriptByName(name);
        if (source == null || !expected.equals(new File(source.getAbsolutePath()).getCanonicalFile()))
            throw new IllegalStateException("Fixture resolved an unexpected script: " + name);
        GhidraScript instance = GhidraScriptUtil.getProvider(source).getScriptInstance(source, errorWriter);
        instance.set(getState(), getControls());
        // Match HeadlessScript.runScript's nested-script setup before invoking
        // the real request handler, which checks the current analysis status.
        Method headless = HeadlessScript.class.getDeclaredMethod("setHeadlessInstance", HeadlessAnalyzer.class);
        headless.setAccessible(true);
        headless.invoke(instance, HeadlessAnalyzer.getInstance());
        return instance;
    }

    private static DecompInterface failing(Function expected, DisposeState disposition) {
        return new DecompInterface() {
            {
                // The bridge reports the effective payload allowance with a failure.
                setOptions(new DecompileOptions());
            }

            @Override
            public DecompileResults decompileFunction(Function function, int timeout, TaskMonitor taskMonitor) {
                if (!function.equals(expected))
                    throw new IllegalStateException("Unexpected decompilation of " + function.getName());
                return new DecompileResults(function, function.getProgram().getLanguage(),
                    function.getProgram().getCompilerSpec(), null, INJECTED, null, disposition);
            }
        };
    }

    private static String failureCode(Throwable failure) throws Exception {
        // A failure other than the bridge's RequestFailure has no code to match.
        if (!failure.getClass().getSimpleName().equals("RequestFailure")) return failure.getClass().getName();
        Field code = failure.getClass().getDeclaredField("code");
        code.setAccessible(true);
        return (String) code.get(failure);
    }

    private static boolean startsWith(String value, String prefix) {
        return value != null && value.startsWith(prefix);
    }

    private static String reason(JsonObject value) {
        JsonElement reason = value.get("reason");
        return reason == null ? null : reason.getAsString();
    }

    private static String selector(Function function) {
        return "0x" + Long.toUnsignedString(function.getEntryPoint().getOffset(), 16);
    }

    /** A decompiler that records what it is asked for and returns an injected timeout. */
    private static DecompInterface injectedWorker(List<String> pooled, List<String> disposed, long holdMillis) {
        return new DecompInterface() {
            @Override
            public DecompileResults decompileFunction(Function function, int timeout, TaskMonitor taskMonitor) {
                pooled.add(function.getName());
                long until = System.nanoTime() + holdMillis * 1_000_000L;
                // Holds until its time passes or its task is cancelled.
                while (System.nanoTime() < until && !taskMonitor.isCancelled()) {
                    try {
                        Thread.sleep(5);
                    } catch (InterruptedException stop) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
                return new DecompileResults(function, function.getProgram().getLanguage(),
                    function.getProgram().getCompilerSpec(), null, INJECTED, null,
                    taskMonitor.isCancelled() ? DisposeState.DISPOSED_ON_CANCEL : DisposeState.DISPOSED_ON_TIMEOUT);
            }

            @Override
            public synchronized void dispose() {
                disposed.add("worker");
                super.dispose();
            }
        };
    }

    private static boolean await(java.util.function.BooleanSupplier condition, long millis) throws InterruptedException {
        long until = System.nanoTime() + millis * 1_000_000L;
        while (System.nanoTime() < until) {
            if (condition.getAsBoolean()) return true;
            Thread.sleep(5);
        }
        return condition.getAsBoolean();
    }

    /**
     * How many workers the bridge starts for {@code queued} functions. The
     * cap is the bridge's own, so a one-CPU host expects one worker.
     */
    private static int readAheadWorkers(Object bridge, int queued) throws Exception {
        Field cap = bridge.getClass().getDeclaredField("DECOMPILE_AHEAD_WORKERS");
        cap.setAccessible(true);
        int limit = Math.max(1, Math.min(Runtime.getRuntime().availableProcessors(), cap.getInt(null)));
        return Math.min(limit, queued);
    }

    /** True once every retained read-ahead task has published its outcome. */
    private static boolean decompileAheadSettled(Field tasks, Object bridge) {
        try {
            Map<?, ?> retained = (Map<?, ?>) tasks.get(bridge);
            if (retained.isEmpty()) return false;
            for (Object task : retained.values()) {
                Field done = task.getClass().getDeclaredField("done");
                done.setAccessible(true);
                if (!((Future<?>) done.get(task)).isDone()) return false;
            }
            return true;
        } catch (ReflectiveOperationException failed) {
            throw new IllegalStateException(failed);
        }
    }

    /**
     * Read-ahead runs beside the carrying request: that request decompiles its
     * own function on the session decompiler without waiting for workers to
     * start. A later request takes a finished result, waits for a running one
     * within the worker's own deadline, or decompiles a queued one itself.
     */
    private void readAhead(GhidraScript bridge, Class<?> requestType, Constructor<?> requestConstructor,
        Object flowLimits, Method handleRequest, Field decompiler, Field limit, Function target,
        String procedure, JsonObject pseudocodeQuery) throws Exception {
        Field opener = bridge.getClass().getDeclaredField("decompileAheadOpener");
        opener.setAccessible(true);
        Field live = bridge.getClass().getDeclaredField("decompileAheadLiveWorkers");
        live.setAccessible(true);
        Field threads = bridge.getClass().getDeclaredField("decompileAheadThreads");
        threads.setAccessible(true);
        Field retained = bridge.getClass().getDeclaredField("decompileResults");
        retained.setAccessible(true);
        Field aheadTasks = bridge.getClass().getDeclaredField("decompileAheadTasks");
        aheadTasks.setAccessible(true);
        Field requestMonitor = ghidra.program.flatapi.FlatProgramAPI.class.getDeclaredField("monitor");
        requestMonitor.setAccessible(true);
        Method dispose = bridge.getClass().getDeclaredMethod("disposeDecompileAhead");
        dispose.setAccessible(true);
        Function own = exportedFunction("rea_cross_leaf");
        Function second = exportedFunction("rea_cross_entry");
        Function third = exportedFunction("rea_cross_indirect");
        List<String> window = List.of(selector(own), selector(second), selector(third));
        List<String> pooled = Collections.synchronizedList(new ArrayList<>());
        List<String> disposed = Collections.synchronizedList(new ArrayList<>());
        List<String> foreground = Collections.synchronizedList(new ArrayList<>());
        Object previous = decompiler.get(bridge);
        Object defaultOpener = opener.get(bridge);
        Object previousMonitor = requestMonitor.get(bridge);
        DecompInterface realSession = (DecompInterface) previous;
        DecompInterface recording = new DecompInterface() {
            {
                setOptions(new DecompileOptions());
            }

            @Override
            public DecompileResults decompileFunction(Function function, int timeout, TaskMonitor taskMonitor) {
                foreground.add(function.getName());
                return realSession.decompileFunction(function, timeout, taskMonitor);
            }
        };
        java.util.function.IntSupplier liveWorkers = () -> {
            try {
                return live.getInt(bridge);
            } catch (IllegalAccessException unreadable) {
                throw new IllegalStateException(unreadable);
            }
        };
        int queuedWorkers = readAheadWorkers(bridge, 2);
        // Released in finally so a failed check cannot leave workers blocked
        // in the opener while disposal waits out its stop bound.
        java.util.concurrent.CountDownLatch release = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.CountDownLatch opening = new java.util.concurrent.CountDownLatch(1);
        Thread opened = null;
        try {
            decompiler.set(bridge, recording);

            // Startup never delays the carrying request, and queued work that
            // no worker has started is decompiled by its own request at once.
            opener.set(bridge, (java.util.function.Function<Integer, DecompInterface>) payload -> {
                try {
                    release.await();
                } catch (InterruptedException stop) {
                    Thread.currentThread().interrupt();
                }
                return injectedWorker(pooled, disposed, 0);
            });
            ((Map<?, ?>) retained.get(bridge)).clear();
            long started = System.nanoTime();
            handleRequest.invoke(bridge, requestConstructor.newInstance(2, "procedure_pseudo_code",
                pseudocodeFor(pseudocodeQuery, own), null, null, flowLimits, window), null);
            long carriedMillis = (System.nanoTime() - started) / 1_000_000;
            require("read_ahead_carrying_request_does_not_wait_for_startup",
                carriedMillis < 2000 && foreground.equals(List.of(own.getName())));
            require("read_ahead_workers_match_queued_work", liveWorkers.getAsInt() == queuedWorkers);
            handleRequest.invoke(bridge, requestConstructor.newInstance(3, "procedure_pseudo_code",
                pseudocodeFor(pseudocodeQuery, second), null, null, flowLimits, List.of()), null);
            require("read_ahead_queued_function_taken_back",
                foreground.contains(second.getName()) && !pooled.contains(second.getName()));
            release.countDown();
            require("read_ahead_worker_takes_queued_function",
                await(() -> pooled.contains(third.getName()), 5000));
            // The worker's injected timeout is that function's outcome.
            try {
                handleRequest.invoke(bridge, requestConstructor.newInstance(4, "procedure_pseudo_code",
                    pseudocodeFor(pseudocodeQuery, third), null, null, flowLimits, List.of()), null);
                throw new IllegalStateException("Read-ahead timeout unexpectedly succeeded");
            } catch (InvocationTargetException failure) {
                require("read_ahead_result_reported_not_decompiled_again",
                    failureCode(failure.getCause()).equals("decompile_timed_out") &&
                    !foreground.contains(third.getName()));
            }
            require("read_ahead_failure_uncached", ((Map<?, ?>) retained.get(bridge)).size() == 2);
            dispose.invoke(bridge);
            require("read_ahead_idle_workers_disposed",
                liveWorkers.getAsInt() == 0 && disposed.size() == queuedWorkers);

            // A running read-ahead is waited for rather than started again.
            pooled.clear();
            foreground.clear();
            disposed.clear();
            ((Map<?, ?>) retained.get(bridge)).clear();
            opener.set(bridge, (java.util.function.Function<Integer, DecompInterface>) payload ->
                injectedWorker(pooled, disposed, 600));
            handleRequest.invoke(bridge, requestConstructor.newInstance(5, "procedure_pseudo_code",
                pseudocodeFor(pseudocodeQuery, own), null, null, flowLimits, window), null);
            require("read_ahead_running", await(() -> pooled.contains(second.getName()), 5000));
            started = System.nanoTime();
            try {
                handleRequest.invoke(bridge, requestConstructor.newInstance(6, "procedure_pseudo_code",
                    pseudocodeFor(pseudocodeQuery, second), null, null, flowLimits, List.of()), null);
                throw new IllegalStateException("Read-ahead timeout unexpectedly succeeded");
            } catch (InvocationTargetException failure) {
                long waitedMillis = (System.nanoTime() - started) / 1_000_000;
                require("read_ahead_running_result_awaited",
                    failureCode(failure.getCause()).equals("decompile_timed_out") &&
                    !foreground.contains(second.getName()) && waitedMillis < 1500);
            }

            // Cancelling a request that waits for a running read-ahead cancels it.
            dispose.invoke(bridge);
            pooled.clear();
            foreground.clear();
            opener.set(bridge, (java.util.function.Function<Integer, DecompInterface>) payload ->
                injectedWorker(pooled, disposed, 60_000));
            handleRequest.invoke(bridge, requestConstructor.newInstance(7, "procedure_pseudo_code",
                pseudocodeFor(pseudocodeQuery, own), null, null, flowLimits, window), null);
            require("read_ahead_running_before_cancel", await(() -> pooled.contains(second.getName()), 5000));
            TaskMonitor cancellable = new ghidra.util.task.TaskMonitorAdapter(true);
            requestMonitor.set(bridge, cancellable);
            Thread canceller = new Thread(() -> {
                try {
                    Thread.sleep(200);
                } catch (InterruptedException stop) {
                    return;
                }
                cancellable.cancel();
            });
            canceller.start();
            started = System.nanoTime();
            try {
                handleRequest.invoke(bridge, requestConstructor.newInstance(8, "procedure_pseudo_code",
                    pseudocodeFor(pseudocodeQuery, second), null, null, flowLimits, List.of()), null);
                throw new IllegalStateException("Cancelled read-ahead wait unexpectedly succeeded");
            } catch (InvocationTargetException failure) {
                canceller.join();
                long waitedMillis = (System.nanoTime() - started) / 1_000_000;
                require("read_ahead_cancel_reaches_running_worker",
                    failureCode(failure.getCause()).equals("decompile_cancelled") && waitedMillis < 5000 &&
                    liveWorkers.getAsInt() == 0);
            } finally {
                requestMonitor.set(bridge, previousMonitor);
            }

            // The handler is blocked on a task it already took. The reader
            // cancels that task and returns; it does not wait out the stop
            // bound, so the cancel frame behind it is still read.
            dispose.invoke(bridge);
            pooled.clear();
            foreground.clear();
            opener.set(bridge, (java.util.function.Function<Integer, DecompInterface>) payload ->
                injectedWorker(pooled, disposed, 60_000));
            handleRequest.invoke(bridge, requestConstructor.newInstance(15, "procedure_pseudo_code",
                pseudocodeFor(pseudocodeQuery, own), null, null, flowLimits, window), null);
            require("read_ahead_running_before_abandon", await(() -> pooled.contains(second.getName()), 5000));
            TaskMonitor waiting = new ghidra.util.task.TaskMonitorAdapter(true);
            requestMonitor.set(bridge, waiting);
            java.util.concurrent.atomic.AtomicReference<Throwable> handlerFailure =
                new java.util.concurrent.atomic.AtomicReference<>();
            Thread handler = new Thread(() -> {
                try {
                    handleRequest.invoke(bridge, requestConstructor.newInstance(16, "procedure_pseudo_code",
                        pseudocodeFor(pseudocodeQuery, second), null, null, flowLimits, List.of()), null);
                    handlerFailure.set(new IllegalStateException("read-ahead wait succeeded"));
                } catch (InvocationTargetException failure) {
                    handlerFailure.set(failure.getCause());
                } catch (Throwable failure) {
                    handlerFailure.set(failure);
                }
            });
            handler.start();
            Thread.sleep(200);
            Method cancelAhead = bridge.getClass().getDeclaredMethod("cancelDecompileAhead");
            cancelAhead.setAccessible(true);
            long abandonStarted = System.nanoTime();
            try {
                cancelAhead.invoke(bridge);
                long cancelMillis = (System.nanoTime() - abandonStarted) / 1_000_000;
                waiting.cancel();
                handler.join(2000);
                long waitedMillis = (System.nanoTime() - abandonStarted) / 1_000_000;
                Throwable cause = handlerFailure.get();
                require("read_ahead_abandoned_while_handler_waits",
                    cancelMillis < 1000 && !handler.isAlive() && waitedMillis < 2000 &&
                    cause != null && failureCode(cause).equals("decompile_cancelled") &&
                    await(() -> liveWorkers.getAsInt() == 0, 2000));
            } finally {
                waiting.cancel();
                handler.join(2000);
                requestMonitor.set(bridge, previousMonitor);
            }

            // A changed decompile deadline reuses a completed result but not
            // a timeout produced under the earlier deadline.
            dispose.invoke(bridge);
            pooled.clear();
            foreground.clear();
            ((Map<?, ?>) retained.get(bridge)).clear();
            limit.setInt(bridge, 1);
            opener.set(bridge, (java.util.function.Function<Integer, DecompInterface>) payload -> {
                DecompInterface real = new DecompInterface() {
                    @Override
                    public DecompileResults decompileFunction(Function function, int timeout, TaskMonitor taskMonitor) {
                        DecompileResults results = super.decompileFunction(function, timeout, taskMonitor);
                        pooled.add(function.getName());
                        return results;
                    }
                };
                real.toggleCCode(true);
                real.toggleSyntaxTree(true);
                real.openProgram(currentProgram);
                return real;
            });
            handleRequest.invoke(bridge, requestConstructor.newInstance(11, "procedure_pseudo_code",
                pseudocodeFor(pseudocodeQuery, own), null, null, flowLimits, window), null);
            require("read_ahead_completed_under_old_deadline",
                await(() -> pooled.contains(second.getName()) && pooled.contains(third.getName()) &&
                    decompileAheadSettled(aheadTasks, bridge), 10000));
            limit.setInt(bridge, 5);
            handleRequest.invoke(bridge, requestConstructor.newInstance(12, "procedure_pseudo_code",
                pseudocodeFor(pseudocodeQuery, third), null, null, flowLimits, List.of()), null);
            require("read_ahead_success_reused_across_deadline_change", !foreground.contains(third.getName()));
            dispose.invoke(bridge);
            pooled.clear();
            foreground.clear();
            ((Map<?, ?>) retained.get(bridge)).clear();
            limit.setInt(bridge, 1);
            opener.set(bridge, (java.util.function.Function<Integer, DecompInterface>) payload ->
                injectedWorker(pooled, disposed, 0));
            handleRequest.invoke(bridge, requestConstructor.newInstance(13, "procedure_pseudo_code",
                pseudocodeFor(pseudocodeQuery, own), null, null, flowLimits, window), null);
            require("read_ahead_timed_out_under_old_deadline",
                await(() -> pooled.contains(second.getName()), 5000));
            limit.setInt(bridge, 5);
            handleRequest.invoke(bridge, requestConstructor.newInstance(14, "procedure_pseudo_code",
                pseudocodeFor(pseudocodeQuery, second), null, null, flowLimits, List.of()), null);
            require("read_ahead_timeout_not_reused_after_deadline_change", foreground.contains(second.getName()));
            limit.setInt(bridge, 0);

            // A one-function remainder starts no worker.
            dispose.invoke(bridge);
            handleRequest.invoke(bridge, requestConstructor.newInstance(9, "procedure_pseudo_code",
                pseudocodeFor(pseudocodeQuery, own), null, null, flowLimits,
                List.of(selector(own), selector(second))), null);
            require("read_ahead_single_remainder_starts_no_worker", liveWorkers.getAsInt() == 0);

            // Workers still opening when read-ahead is disposed close unused.
            dispose.invoke(bridge);
            pooled.clear();
            disposed.clear();
            ((Map<?, ?>) retained.get(bridge)).clear();
            opener.set(bridge, (java.util.function.Function<Integer, DecompInterface>) payload -> {
                try {
                    opening.await();
                } catch (InterruptedException stop) {
                    Thread.currentThread().interrupt();
                }
                return injectedWorker(pooled, disposed, 0);
            });
            handleRequest.invoke(bridge, requestConstructor.newInstance(10, "procedure_pseudo_code",
                pseudocodeFor(pseudocodeQuery, own), null, null, flowLimits, window), null);
            opened = new Thread(() -> {
                try {
                    Thread.sleep(200);
                } catch (InterruptedException stop) {
                    return;
                }
                opening.countDown();
            });
            opened.start();
            dispose.invoke(bridge);
            opened.join();
            require("read_ahead_opening_workers_disposed",
                liveWorkers.getAsInt() == 0 && pooled.isEmpty() && disposed.size() == queuedWorkers);

            // Real decompiler processes open the Program concurrently.
            opener.set(bridge, defaultOpener);
            Method open = bridge.getClass().getDeclaredMethod("openDecompileAheadDecompiler", Integer.class);
            open.setAccessible(true);
            List<DecompInterface> opened4 = Collections.synchronizedList(new ArrayList<>());
            List<Thread> openers = new ArrayList<>();
            long openStarted = System.nanoTime();
            for (int index = 0; index < 4; index++) {
                Thread thread = new Thread(() -> {
                    try {
                        opened4.add((DecompInterface) open.invoke(bridge, (Integer) null));
                    } catch (ReflectiveOperationException failed) {
                        // Reported by the count below.
                    }
                });
                openers.add(thread);
                thread.start();
            }
            for (Thread thread : openers) thread.join();
            long openMillis = (System.nanoTime() - openStarted) / 1_000_000;
            boolean usable = opened4.size() == 4;
            for (DecompInterface each : opened4) {
                usable &= each.decompileFunction(own, 30, TaskMonitor.DUMMY).decompileCompleted();
                each.dispose();
            }
            println("REA_DECOMPILER_FAILURE_PROBE_OPEN_MILLIS " + openMillis);
            require("read_ahead_concurrent_open_program", usable);
            require("read_ahead_private_thread_pool",
                threads.get(bridge) instanceof java.util.concurrent.ExecutorService);
        } finally {
            release.countDown();
            opening.countDown();
            try {
                if (opened != null) opened.join();
            } finally {
                try {
                    dispose.invoke(bridge);
                } finally {
                    limit.setInt(bridge, 0);
                    opener.set(bridge, defaultOpener);
                    requestMonitor.set(bridge, previousMonitor);
                    decompiler.set(bridge, previous);
                }
            }
        }

        // The hint is advisory: a longer one is clamped to one window, never refused.
        Method parse = bridge.getClass().getDeclaredMethod("parseRequest", String.class, String.class);
        parse.setAccessible(true);
        JsonArray selectors = new JsonArray();
        for (int index = 0; index < 40; index++) selectors.add("0x" + Integer.toHexString(0x1000 + index * 0x10));
        JsonObject line = new JsonObject();
        line.addProperty("id", 3);
        line.addProperty("token", "probe");
        line.addProperty("method", "procedure_pseudo_code");
        line.add("params", pseudocodeQuery);
        line.add("decompile_read_ahead", selectors);
        Object parsed = parse.invoke(null, line.toString(), "probe");
        Method readAheadOf = requestType.getDeclaredMethod("decompileReadAhead");
        readAheadOf.setAccessible(true);
        List<?> kept = (List<?>) readAheadOf.invoke(parsed);
        List<String> expected = new ArrayList<>();
        for (int index = 0; index < 32; index++) expected.add(selectors.get(index).getAsString());
        require("read_ahead_hint_clamped_to_window", kept.equals(expected));
    }

    /** The probe's pseudocode query, selecting another function. */
    private static JsonObject pseudocodeFor(JsonObject query, Function function) {
        JsonObject selected = query.deepCopy();
        selected.addProperty("procedure", selector(function));
        return selected;
    }

    private Object parsedRequest(GhidraScript bridge, String method, JsonObject params, JsonElement payload)
        throws Exception {
        Method parse = bridge.getClass().getDeclaredMethod("parseRequest", String.class, String.class);
        parse.setAccessible(true);
        JsonObject line = new JsonObject();
        line.addProperty("id", 4);
        line.addProperty("token", "probe");
        line.addProperty("method", method);
        line.add("params", params);
        if (payload != null) line.add("decompile_max_payload_mib", payload);
        return parse.invoke(null, line.toString(), "probe");
    }

    /**
     * A read that carries no decompiler options, as procedure_info and
     * instruction reads do, keeps the configured payload limit and the
     * decompiles completed under it. An explicit null still restores the
     * installed default.
     */
    private void readsKeepDecompiles(GhidraScript bridge, Class<?> requestType, Field completed,
        Method pseudocode, JsonObject pseudocodeQuery) throws Exception {
        Method apply = bridge.getClass().getDeclaredMethod("applyRequestDecompilerOptions", requestType);
        apply.setAccessible(true);
        Field payload = bridge.getClass().getDeclaredField("decompileMaxPayloadMiB");
        payload.setAccessible(true);
        Map<?, ?> cache = (Map<?, ?>) completed.get(bridge);
        cache.clear();
        apply.invoke(bridge, parsedRequest(bridge, "procedure_pseudo_code", pseudocodeQuery,
            new com.google.gson.JsonPrimitive(64)));
        pseudocode.invoke(bridge, pseudocodeQuery);
        int retained = cache.size();
        require("configured_payload_decompile_retained", retained > 0 && Integer.valueOf(64).equals(payload.get(bridge)));
        apply.invoke(bridge, parsedRequest(bridge, "procedure_info", new JsonObject(), null));
        require("read_without_decompiler_options_keeps_payload_limit", Integer.valueOf(64).equals(payload.get(bridge)));
        require("read_without_decompiler_options_keeps_decompiles", cache.size() == retained);
        apply.invoke(bridge, parsedRequest(bridge, "procedure_pseudo_code", pseudocodeQuery, JsonNull.INSTANCE));
        require("explicit_null_payload_restores_default", payload.get(bridge) == null && cache.isEmpty());
    }

    /**
     * Decompiling code outside every function widens the on-the-fly
     * UndefinedFunction's body. A reused result keeps that widened function,
     * so its boundary limitations cover the decompiled code rather than the
     * entry-only body of a fresh lookup.
     */
    private void reusedUndefinedFunctionBody(GhidraScript bridge, Field completed, Method pseudocode,
        Function defined) throws Exception {
        Method decompile = bridge.getClass().getDeclaredMethod("decompile", Function.class);
        decompile.setAccessible(true);
        Method decompiledFunction = bridge.getClass().getDeclaredMethod(
            "decompiledFunction", Function.class, DecompileResults.class);
        decompiledFunction.setAccessible(true);
        Field inventory = bridge.getClass().getDeclaredField("procedureInventory");
        inventory.setAccessible(true);
        ghidra.program.model.address.Address entry = defined.getEntryPoint();
        JsonObject query = new JsonObject();
        query.add("document", JsonNull.INSTANCE);
        query.addProperty("procedure", "0x" + Long.toUnsignedString(entry.getOffset(), 16));
        int transaction = currentProgram.startTransaction("Orphan the fixture function");
        try {
            // Removing the function leaves its instructions disassembled, as
            // Ghidra leaves code an analyzer never made a function.
            currentProgram.getFunctionManager().removeFunction(entry);
            inventory.set(bridge, null);
            ((Map<?, ?>) completed.get(bridge)).clear();
            JsonObject first = (JsonObject) pseudocode.invoke(bridge, query);
            JsonObject repeated = (JsonObject) pseudocode.invoke(bridge, query);
            require("undefined_function_repeat_keeps_limitations",
                first.get("limitations").equals(repeated.get("limitations")));
            UndefinedFunction fresh = UndefinedFunction.findFunction(currentProgram, entry, monitor);
            DecompileResults reused = (DecompileResults) decompile.invoke(bridge, fresh);
            Function covered = (Function) decompiledFunction.invoke(null, fresh, reused);
            require("undefined_function_reuse_keeps_widened_body",
                fresh.getBody().getNumAddresses() == 1 &&
                covered.getBody().getNumAddresses() > fresh.getBody().getNumAddresses());
        } finally {
            currentProgram.endTransaction(transaction, false);
            inventory.set(bridge, null);
            ((Map<?, ?>) completed.get(bridge)).clear();
        }
    }

    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length != 1) throw new IllegalArgumentException("Expected exact bridge directory");
        File directory = new File(args[0]).getCanonicalFile();
        GhidraScript bridge = script("ReaGhidraBridge.java", new File(directory, "ReaGhidraBridge.java"));
        Field space = bridge.getClass().getDeclaredField("sessionDefaultAddressSpace");
        space.setAccessible(true);
        space.set(null, currentProgram.getAddressFactory().getDefaultAddressSpace());
        Method initialize = bridge.getClass().getDeclaredMethod("initializeDecompiler");
        initialize.setAccessible(true);
        initialize.invoke(bridge);

        // Exercise the real production error factory, without claiming a natural regex overflow.
        Method regexFactory = bridge.getClass().getDeclaredMethod(
            "regexStackExhausted", String.class, String.class);
        regexFactory.setAccessible(true);
        Throwable regexFailure = (Throwable) regexFactory.invoke(null, "(a+)+$", "matching");
        require("regex_failure_preserves_stage_and_pattern",
                failureCode(regexFailure).equals("regex_stack_exhausted") &&
                regexFailure.getMessage().contains("matching pattern (a+)+$."));
        require("regex_failure_leaves_lifecycle_to_provider",
                !regexFailure.getMessage().contains("session") &&
                !regexFailure.getMessage().contains("Use literal"));
        Class<?> requestType = Class.forName(bridge.getClass().getName() + "$Request", true, bridge.getClass().getClassLoader());
        Class<?> descriptorType = Class.forName(bridge.getClass().getName() + "$SessionDescriptor", true, bridge.getClass().getClassLoader());
        Constructor<?> requestConstructor = requestType.getDeclaredConstructors()[0];
        requestConstructor.setAccessible(true);
        Method defaultFlowLimits = bridge.getClass().getDeclaredMethod("defaultValueFlowLimits");
        defaultFlowLimits.setAccessible(true);
        Object flowLimits = defaultFlowLimits.invoke(null);
        Method analyze = bridge.getClass().getDeclaredMethod("handleRequest", requestType, descriptorType);
        analyze.setAccessible(true);
        Method pseudocode = bridge.getClass().getDeclaredMethod("procedurePseudocode", JsonObject.class);
        pseudocode.setAccessible(true);
        Field decompiler = bridge.getClass().getDeclaredField("decompiler");
        decompiler.setAccessible(true);
        DecompInterface real = (DecompInterface) decompiler.get(bridge);
        // Completed decompilations are reused, so each injected decompiler
        // starts from an empty result cache to be called at all.
        Field completed = bridge.getClass().getDeclaredField("decompileResults");
        completed.setAccessible(true);

        Function target = exportedFunction("rea_cross_branch");
        String procedure = "0x" + Long.toUnsignedString(target.getEntryPoint().getOffset(), 16);
        JsonObject query = new JsonObject();
        query.addProperty("procedure", procedure);
        // Exercise the actual wire response producer, including cache metadata.
        Object request = requestConstructor.newInstance(1, "analyze_function", query, null, null, flowLimits, List.of());
        JsonObject pseudocodeQuery = new JsonObject();
        pseudocodeQuery.add("document", JsonNull.INSTANCE);
        pseudocodeQuery.addProperty("procedure", procedure);

        JsonObject baseline;
        JsonObject degraded;
        try {
            baseline = (JsonObject) analyze.invoke(bridge, request, null);
            JsonObject value = baseline.getAsJsonObject("value");
            require("healthy_snapshot_policy_preserved", !baseline.has("cache_policy"));
            require("baseline_pseudocode_available", !value.get("pseudocode").getAsString().isEmpty() &&
                value.getAsJsonObject("facet_availability").getAsJsonObject("pseudocode").get("available").getAsBoolean());
            require("baseline_native_api_available", value.getAsJsonObject("native_api").get("available").getAsBoolean());
            require("baseline_assembly_present", value.getAsJsonArray("assembly").size() > 0);
            require("baseline_callers_present", value.getAsJsonArray("callers").size() > 0);
            require("baseline_callees_present", value.getAsJsonArray("callees").size() > 0);
            require("baseline_multiple_blocks_present", value.getAsJsonArray("basic_blocks").size() > 1);

            ((Map<?, ?>) completed.get(bridge)).clear();
            decompiler.set(bridge, failing(target, DisposeState.NOT_DISPOSED));
            degraded = (JsonObject) analyze.invoke(bridge, request, null);
            JsonObject dossier = degraded.getAsJsonObject("value");
            require("decompiler_failure_is_live", degraded.get("cache_policy").getAsString().equals("live"));
            // The failure goes on to name the payload allowance and its recovery.
            String expected = "Ghidra decompilation failed: " + INJECTED + ". ";
            require("dossier_returned", dossier.getAsJsonObject("procedure").get("address").getAsString()
                .equals(value.getAsJsonObject("procedure").get("address").getAsString()));
            JsonObject facets = dossier.getAsJsonObject("facet_availability");
            require("pseudocode_unavailable_with_failure", dossier.get("pseudocode").getAsString().isEmpty() &&
                !facets.getAsJsonObject("pseudocode").get("available").getAsBoolean() &&
                startsWith(reason(facets.getAsJsonObject("pseudocode")), expected));
            require("native_api_unavailable_with_failure",
                !dossier.getAsJsonObject("native_api").get("available").getAsBoolean() &&
                startsWith(reason(dossier.getAsJsonObject("native_api")), expected));
            require("native_value_flow_unavailable_with_failure",
                !dossier.getAsJsonObject("native_value_flow").get("available").getAsBoolean() &&
                startsWith(reason(dossier.getAsJsonObject("native_value_flow")), expected));
            for (String facet : LISTING_FACETS)
                require("listing_facet_unchanged_" + facet, dossier.get(facet).equals(value.get(facet)));
            for (String facet : List.of("assembly", "comments", "callers", "callees", "references", "strings_names", "cfg"))
                require("facet_availability_unchanged_" + facet,
                    facets.get(facet).equals(value.getAsJsonObject("facet_availability").get(facet)));
            require("relationship_coverage_unchanged",
                degraded.get("relationship_coverage").equals(baseline.get("relationship_coverage")));
            boolean named = false;
            for (JsonElement item : dossier.getAsJsonArray("limitations"))
                named |= item.getAsString().startsWith(expected) &&
                    item.getAsString().contains("Pseudocode, the native API boundary") &&
                    item.getAsString().contains("were still collected");
            require("failure_limitation_named", named);

            try {
                pseudocode.invoke(bridge, pseudocodeQuery);
                throw new IllegalStateException("Pseudocode request unexpectedly succeeded");
            } catch (InvocationTargetException failure) {
                require("pseudocode_request_still_fails",
                    failureCode(failure.getCause()).equals("decompile_failed") &&
                    failure.getCause().getMessage().startsWith(expected));
            }

            ((Map<?, ?>) completed.get(bridge)).clear();
            decompiler.set(bridge, failing(target, DisposeState.DISPOSED_ON_CANCEL));
            try {
                analyze.invoke(bridge, request, null);
                throw new IllegalStateException("Cancelled decompilation unexpectedly returned a dossier");
            } catch (InvocationTargetException failure) {
                require("cancellation_still_ends_request",
                    failureCode(failure.getCause()).equals("decompile_cancelled"));
            }

            // A decompile that reaches REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS degrades the
            // same way, names the setting, and stays out of snapshots.
            Field limit = bridge.getClass().getDeclaredField("decompileTimeoutSeconds");
            limit.setAccessible(true);
            limit.setInt(bridge, 5);
            String limitText = "exceeded the 5-second configured decompilation limit " +
                "(ghidra.decompile_timeout_seconds; launch seed REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS)";
            ((Map<?, ?>) completed.get(bridge)).clear();
            decompiler.set(bridge, failing(target, DisposeState.DISPOSED_ON_TIMEOUT));
            JsonObject timedOut = (JsonObject) analyze.invoke(bridge, request, null);
            JsonObject timedOutDossier = timedOut.getAsJsonObject("value");
            require("timed_out_decompile_is_live",
                timedOut.has("cache_policy") && timedOut.get("cache_policy").getAsString().equals("live"));
            String timedOutReason = reason(timedOutDossier.getAsJsonObject("facet_availability")
                .getAsJsonObject("pseudocode"));
            require("timed_out_pseudocode_names_limit", timedOutReason != null &&
                timedOutReason.startsWith("Ghidra decompilation of ") && timedOutReason.endsWith(limitText));
            require("timed_out_native_api_names_limit",
                !timedOutDossier.getAsJsonObject("native_api").get("available").getAsBoolean() &&
                timedOutReason.equals(reason(timedOutDossier.getAsJsonObject("native_api"))));
            require("timed_out_listing_unchanged",
                timedOutDossier.get("assembly").equals(value.get("assembly")) &&
                timedOutDossier.get("basic_blocks").equals(value.get("basic_blocks")));
            try {
                pseudocode.invoke(bridge, pseudocodeQuery);
                throw new IllegalStateException("Timed-out pseudocode request unexpectedly succeeded");
            } catch (InvocationTargetException failure) {
                require("timed_out_pseudocode_request_names_limit",
                    failureCode(failure.getCause()).equals("decompile_timed_out") &&
                    failure.getCause().getMessage().endsWith(limitText));
            }
            limit.setInt(bridge, 0);

            decompiler.set(bridge, real);
            JsonObject recovered = (JsonObject) analyze.invoke(bridge, request, null);
            require("session_recovers_after_failure", recovered.getAsJsonObject("value")
                .getAsJsonObject("facet_availability").getAsJsonObject("pseudocode").get("available").getAsBoolean());

            readAhead(bridge, requestType, requestConstructor, flowLimits, analyze, decompiler,
                limit, target, procedure, pseudocodeQuery);
            readsKeepDecompiles(bridge, requestType, completed, pseudocode, pseudocodeQuery);
            reusedUndefinedFunctionBody(bridge, completed, pseudocode, exportedFunction("rea_cross_leaf"));
        } finally {
            decompiler.set(bridge, real);
            real.dispose();
        }

        JsonObject report = new JsonObject();
        report.addProperty("status", "passed");
        report.addProperty("ghidra_version", Application.getApplicationVersion());
        report.addProperty("target_sha256", currentProgram.getExecutableSHA256());
        byte[] bytes = Files.readAllBytes(new File(directory, "ReaGhidraBridge.java").toPath());
        report.addProperty("ReaGhidraBridge.java",
            HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)));
        report.add("checks", checks);
        report.add("baseline", baseline);
        report.add("degraded", degraded);
        println("REA_DECOMPILER_FAILURE_PROBE_JSON " + report);
    }
}
