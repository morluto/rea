//@category REA Verification

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import generic.concurrent.GThreadPool;
import generic.jar.ResourceFile;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileOptions;
import ghidra.app.decompiler.DecompileProcess.DisposeState;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.decompiler.parallel.DecompilerCallback;
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

    /**
     * A read-ahead window carries its request's own function first. That
     * request reports the window's outcome for it instead of decompiling again,
     * and waits for the window only within its own deadline.
     */
    private void readAhead(GhidraScript bridge, Class<?> requestType, Constructor<?> requestConstructor,
        Object flowLimits, Method handleRequest, Field decompiler, Field limit, Function target,
        String procedure, JsonObject pseudocodeQuery) throws Exception {
        Field workers = bridge.getClass().getDeclaredField("decompileAheadWorkers");
        workers.setAccessible(true);
        Field threads = bridge.getClass().getDeclaredField("decompileAheadThreads");
        threads.setAccessible(true);
        Field retained = bridge.getClass().getDeclaredField("decompileResults");
        retained.setAccessible(true);
        Method dispose = bridge.getClass().getDeclaredMethod("disposeDecompileAhead");
        dispose.setAccessible(true);
        Function sibling = exportedFunction("rea_cross_leaf");
        String siblingSelector = "0x" + Long.toUnsignedString(sibling.getEntryPoint().getOffset(), 16);
        List<String> pooled = Collections.synchronizedList(new ArrayList<>());
        List<String> foreground = Collections.synchronizedList(new ArrayList<>());
        DecompilerCallback<DecompileResults> window = new DecompilerCallback<>(currentProgram, prepared -> {}) {
            @Override
            public DecompileResults process(Function function, TaskMonitor taskMonitor) throws Exception {
                pooled.add(function.getName());
                if (function.equals(target))
                    return new DecompileResults(function, function.getProgram().getLanguage(),
                        function.getProgram().getCompilerSpec(), null, INJECTED, null, DisposeState.DISPOSED_ON_TIMEOUT);
                // A sibling that never finishes on its own holds the window open.
                while (!taskMonitor.isCancelled()) Thread.sleep(10);
                return null;
            }

            @Override
            public DecompileResults process(DecompileResults results, TaskMonitor taskMonitor) {
                return results;
            }
        };
        DecompInterface again = new DecompInterface() {
            @Override
            public DecompileResults decompileFunction(Function function, int timeout, TaskMonitor taskMonitor) {
                foreground.add(function.getName());
                throw new IllegalStateException("Foreground decompiled again after read-ahead");
            }
        };
        Object previous = decompiler.get(bridge);
        try {
            ((Map<?, ?>) retained.get(bridge)).clear();
            dispose.invoke(bridge);
            workers.set(bridge, window);
            decompiler.set(bridge, again);
            limit.setInt(bridge, 1);
            Object request = requestConstructor.newInstance(2, "procedure_pseudo_code", pseudocodeQuery, null, null,
                flowLimits, List.of(procedure, siblingSelector));
            long started = System.nanoTime();
            try {
                handleRequest.invoke(bridge, request, null);
                throw new IllegalStateException("Read-ahead timeout unexpectedly succeeded");
            } catch (InvocationTargetException failure) {
                require("read_ahead_foreground_timeout_reported",
                    failureCode(failure.getCause()).equals("decompile_timed_out") &&
                    failure.getCause().getMessage().contains("exceeded the 1-second configured decompilation limit"));
            }
            long elapsedMillis = (System.nanoTime() - started) / 1_000_000;
            require("read_ahead_foreground_not_decompiled_again", foreground.isEmpty() &&
                pooled.contains(target.getName()) && pooled.contains(sibling.getName()));
            // One second of deadline plus cancellation and scheduling slack, far
            // below the deadline elapsing again for the foreground.
            require("read_ahead_window_within_foreground_deadline", elapsedMillis >= 900 && elapsedMillis < 1900);
            require("read_ahead_cancelled_sibling_uncached", ((Map<?, ?>) retained.get(bridge)).isEmpty());
            // GThreadPool registers every pool by name, so isPrivate() cannot
            // tell; the property is that Ghidra's own decompiler pool is not it.
            require("read_ahead_private_thread_pool", threads.get(bridge) != null &&
                threads.get(bridge) != GThreadPool.getSharedThreadPool("Parallel Decompiler"));
        } finally {
            limit.setInt(bridge, 0);
            decompiler.set(bridge, previous);
            dispose.invoke(bridge);
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
