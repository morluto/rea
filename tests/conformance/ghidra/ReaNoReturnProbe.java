//@category REA Verification

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import generic.jar.ResourceFile;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.script.GhidraScript;
import ghidra.app.script.GhidraScriptUtil;
import ghidra.framework.Application;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSet;
import ghidra.program.model.listing.FlowOverride;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.symbol.FlowType;
import ghidra.program.model.symbol.SourceType;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.RefType;
import java.io.File;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.ArrayList;
import java.util.Set;
import java.util.TreeSet;

/** Injects reported analysis flags into imported ELF/Mach-O functions; never executes target code. */
public class ReaNoReturnProbe extends GhidraScript {
    private record MemoryCallReference(Address source, Address target, RefType type,
        SourceType sourceType, int operandIndex, boolean primary) {}
    /** A computed call's state before the repair: which flows, body and pseudocode it had. */
    private record ComputedCall(String name, boolean ends, boolean constant, Address call, Address fallthrough,
        FlowOverride override, Set<Address> targets, AddressSet body, String pseudocode) {}
    private final JsonArray checks = new JsonArray();
    private final Map<Function, Address> originalEnds = new LinkedHashMap<>();
    private final Map<Function, String> originalSignatures = new LinkedHashMap<>();

    private void require(String name, boolean condition) {
        if (!condition) throw new IllegalStateException("No-return assertion failed: " + name);
        checks.add(name);
    }

    private boolean matchesSymbol(Function function, String name) {
        String observed = function.getName();
        // Mach-O symbol names use a leading underscore for C-linkage names.
        return observed.equals(name) || observed.equals("_" + name);
    }

    private Function function(String name) {
        for (Function f : currentProgram.getFunctionManager().getFunctions(true))
            if (!f.isThunk() && matchesSymbol(f, name)) return f;
        throw new IllegalStateException("Missing fixture function " + name);
    }

    private Function external(String name) {
        for (Function f : currentProgram.getFunctionManager().getExternalFunctions())
            if (matchesSymbol(f, name)) return f;
        throw new IllegalStateException("Missing imported function " + name);
    }

    private void truncate(Function caller, String callee) throws Exception {
        truncate(caller, external(callee));
    }

    private void truncate(Function caller, Function callee) throws Exception {
        for (Instruction ins : currentProgram.getListing().getInstructions(caller.getBody(), true)) {
            if (!ins.getFlowType().isCall()) continue;
            Address[] flows = ins.getFlows();
            if (flows.length != 1) continue;
            Function target = currentProgram.getFunctionManager().getFunctionAt(flows[0]);
            if (target == null) continue;
            Function root = target.isThunk() ? target.getThunkedFunction(true) : target;
            if (root == null || !root.equals(callee)) continue;
            originalEnds.put(caller, caller.getBody().getMaxAddress());
            originalSignatures.put(caller, caller.getPrototypeString(false, true));
            callee.setNoReturn(true);
            ins.setFlowOverride(FlowOverride.CALL_RETURN);
            Address end = ins.getMaxAddress();
            clearListing(end.add(1), originalEnds.get(caller));
            caller.setBody(new AddressSet(caller.getEntryPoint(), end));
            require("truncated_" + callee.getName(), ins.getFlowType().isTerminal());
            return;
        }
        throw new IllegalStateException("Missing fixture call to " + callee.getName());
    }

    private GhidraScript script(String name, File expected) throws Exception {
        ResourceFile source = GhidraScriptUtil.findScriptByName(name);
        if (source == null || !expected.equals(new File(source.getAbsolutePath()).getCanonicalFile()))
            throw new IllegalStateException("Fixture resolved an unexpected script: " + name);
        GhidraScript instance = GhidraScriptUtil.getProvider(source).getScriptInstance(source, errorWriter);
        instance.set(getState(), getControls());
        return instance;
    }

    private void knownInteriorCall(GhidraScript bridge) throws Exception {
        Function caller = function("rea_tls_chain");
        Function target = function("rea_tls");
        Address interior = target.getEntryPoint().add(1);
        require("interior_target_is_owned", currentProgram.getFunctionManager().getFunctionAt(interior) == null &&
            target.equals(currentProgram.getFunctionManager().getFunctionContaining(interior)));
        Instruction call = null;
        for (Instruction instruction : currentProgram.getListing().getInstructions(caller.getBody(), true)) {
            if (instruction.getFlowType().isCall()) { call = instruction; break; }
        }
        if (call == null) throw new IllegalStateException("Missing real call instruction");
        var references = currentProgram.getReferenceManager();
        List<Reference> originals = new ArrayList<>();
        List<MemoryCallReference> saved = new ArrayList<>();
        for (Reference reference : call.getReferencesFrom()) {
            if (!reference.getReferenceType().isCall()) continue;
            originals.add(reference);
            saved.add(new MemoryCallReference(reference.getFromAddress(), reference.getToAddress(),
                reference.getReferenceType(), reference.getSource(), reference.getOperandIndex(), reference.isPrimary()));
        }
        require("original_call_reference_present", !originals.isEmpty());
        Reference changed = null;
        try {
            for (Reference reference : originals) references.delete(reference);
            changed = references.addMemoryReference(call.getAddress(), interior,
                RefType.UNCONDITIONAL_CALL, SourceType.USER_DEFINED, 0);
            require("interior_target_omitted_by_callee_getter", !caller.getCalledFunctions(monitor).contains(target));
            JsonObject query = new JsonObject();
            query.addProperty("document", currentProgram.getName());
            query.addProperty("procedure", caller.getName());
            query.addProperty("direction", "outgoing");
            Method read = bridge.getClass().getDeclaredMethod("procedureReferences", JsonObject.class);
            read.setAccessible(true);
            // procedureReferences returns a function observation envelope.
            JsonObject output = ((JsonObject) read.invoke(bridge, query)).getAsJsonObject("value");
            require("interior_reference_keeps_known_procedure", output.getAsJsonArray("references").asList().stream().anyMatch(
                edge -> !edge.getAsJsonObject().get("target_procedure").isJsonNull() &&
                    edge.getAsJsonObject().getAsJsonObject("target_procedure").get("name").getAsString().equals(target.getName())));
            require("known_reference_is_not_also_unresolved", output.getAsJsonArray("unresolved_calls").isEmpty());
            query.remove("direction");
            Method callees = bridge.getClass().getDeclaredMethod("procedureCalls", JsonObject.class, boolean.class);
            callees.setAccessible(true);
            JsonObject inventory = (JsonObject) callees.invoke(bridge, query, false);
            require("omitted_callee_inventory_stays_partial", inventory.getAsJsonObject("relationship_coverage").get("status").getAsString().equals("partial"));
            require("omitted_callee_direction_is_explicit",
                inventory.getAsJsonObject("relationship_coverage").getAsJsonArray("limited_directions").toString().equals("[\"callees\"]"));
            require("interior_caller_omitted_by_entry_getter", !target.getCallingFunctions(monitor).contains(caller));
            query.addProperty("procedure", target.getName());
            JsonObject incoming = (JsonObject) callees.invoke(bridge, query, true);
            require("off_entry_caller_inventory_stays_partial",
                incoming.getAsJsonObject("relationship_coverage").get("status").getAsString().equals("partial"));
            require("off_entry_caller_direction_is_explicit",
                incoming.getAsJsonObject("relationship_coverage").getAsJsonArray("limited_directions").toString().equals("[\"callers\"]"));
            JsonObject dossierQuery = new JsonObject();
            dossierQuery.addProperty("procedure", target.getName());
            Method analyze = bridge.getClass().getDeclaredMethod("analyzeFunctionObservation", JsonObject.class);
            analyze.setAccessible(true);
            Object observation = analyze.invoke(bridge, dossierQuery);
            Method coverage = observation.getClass().getDeclaredMethod("relationshipCoverage");
            coverage.setAccessible(true);
            require("dossier_preserves_caller_only_gap",
                ((JsonObject) coverage.invoke(observation)).getAsJsonArray("limited_directions").toString().equals("[\"callers\"]"));
        } finally {
            if (changed != null) references.delete(changed);
            for (MemoryCallReference reference : saved) {
                Reference restored = references.addMemoryReference(reference.source(), reference.target(),
                    reference.type(), reference.sourceType(), reference.operandIndex());
                references.setPrimary(restored, reference.primary());
            }
        }
    }

    private void nonCallInstructionReference(GhidraScript bridge) throws Exception {
        Function caller = function("rea_tls_chain");
        Function target = function("rea_memcpy");
        Instruction source = null;
        for (Instruction instruction : currentProgram.getListing().getInstructions(caller.getBody(), true)) {
            if (!instruction.getFlowType().isCall()) { source = instruction; break; }
        }
        if (source == null) throw new IllegalStateException("Missing non-call instruction");
        var references = currentProgram.getReferenceManager();
        Reference added = references.addMemoryReference(source.getAddress(), target.getEntryPoint().add(1),
            RefType.UNCONDITIONAL_CALL, SourceType.USER_DEFINED, -1);
        try {
            require("non_call_reference_target_omitted", !caller.getCalledFunctions(monitor).contains(target));
            JsonObject query = new JsonObject();
            query.addProperty("document", currentProgram.getName());
            query.addProperty("procedure", caller.getName());
            Method read = bridge.getClass().getDeclaredMethod("procedureCalls", JsonObject.class, boolean.class);
            read.setAccessible(true);
            JsonObject output = (JsonObject) read.invoke(bridge, query, false);
            require("non_call_instruction_reference_stays_partial",
                output.getAsJsonObject("relationship_coverage").get("status").getAsString().equals("partial"));
            query.addProperty("direction", "outgoing");
            Method edges = bridge.getClass().getDeclaredMethod("procedureReferences", JsonObject.class);
            edges.setAccessible(true);
            JsonObject known = ((JsonObject) edges.invoke(bridge, query)).getAsJsonObject("value");
            require("non_call_known_reference_is_not_unresolved", known.getAsJsonArray("unresolved_calls").isEmpty());
            references.delete(added);
            Address unknown = currentProgram.getMemory().getMaxAddress().add(0x1000);
            added = references.addMemoryReference(source.getAddress(), unknown,
                RefType.UNCONDITIONAL_CALL, SourceType.USER_DEFINED, -1);
            JsonObject unresolved = ((JsonObject) edges.invoke(bridge, query)).getAsJsonObject("value");
            require("non_call_unknown_reference_keeps_site", unresolved.getAsJsonArray("unresolved_calls").size() == 1);
        } finally {
            references.delete(added);
        }
    }

    private Instruction computedCall(Function caller) {
        Instruction found = null;
        for (Instruction ins : currentProgram.getListing().getInstructions(caller.getBody(), true)) {
            FlowType flow = ins.getFlowType();
            if (!flow.isCall() || !flow.isComputed()) continue;
            if (found != null) throw new IllegalStateException("Two computed calls in " + caller.getName());
            found = ins;
        }
        require("computed_call_falls_through_" + caller.getName(), found != null &&
            found.getDefaultFlows().length == 0 && !found.getFlowType().isTerminal() && found.getFallThrough() != null);
        return found;
    }

    private Set<Address> callTargets(Instruction call) {
        Set<Address> targets = new TreeSet<>();
        for (Reference reference : call.getReferencesFrom())
            if (reference.getReferenceType().isCall()) targets.add(reference.getToAddress());
        return targets;
    }

    /** Add the COMPUTED_CALL reference that Ghidra's analysis records for a resolved target. */
    private void recordTarget(Instruction call, Function target) {
        if (callTargets(call).contains(target.getEntryPoint())) return;
        currentProgram.getReferenceManager().addMemoryReference(call.getAddress(), target.getEntryPoint(),
            RefType.COMPUTED_CALL, SourceType.ANALYSIS, 0);
    }

    private void forgetOtherTargets(Instruction call, Function target) {
        for (Reference reference : call.getReferencesFrom())
            if (reference.getReferenceType().isCall() && !reference.getToAddress().equals(target.getEntryPoint()))
                currentProgram.getReferenceManager().delete(reference);
    }

    private String pseudocode(Function function) {
        DecompInterface decompiler = new DecompInterface();
        try {
            if (!decompiler.openProgram(currentProgram))
                throw new IllegalStateException("Decompiler: " + decompiler.getLastMessage());
            var result = decompiler.decompileFunction(function, 60, monitor);
            if (!result.decompileCompleted())
                throw new IllegalStateException("Decompiler: " + result.getErrorMessage());
            return result.getDecompiledFunction().getC();
        } finally {
            decompiler.dispose();
        }
    }

    /**
     * Real decoded computed calls to a local no-return function. Inline assembly fixes three call
     * targets in the instruction stream, and a writable slot supplies the fourth. The fifth
     * target is a conditional move between a returning and the no-return address, which Ghidra's
     * p-code expresses as a CBRANCH over the COPY. Besides the code, only the injected state
     * differs: a second recorded target, an existing override, and the one reference recorded
     * for the no-return value of the slot and the conditional move. Only the first call may end.
     */
    private List<ComputedCall> computedCalls() throws Exception {
        Function stop = function("rea_computed_stop");
        stop.setNoReturn(true);
        Map<String, Boolean> callers = new LinkedHashMap<>();
        callers.put("rea_constant_call", true);
        callers.put("rea_constant_call_two_targets", false);
        callers.put("rea_constant_call_overridden", false);
        callers.put("rea_hook_call", false);
        callers.put("rea_conditional_call", false);
        // The decompiler can resolve only the fixed targets; it continues past the other calls.
        Set<String> variable = Set.of("rea_hook_call", "rea_conditional_call");
        List<ComputedCall> calls = new ArrayList<>();
        for (var item : callers.entrySet()) {
            Function caller = function(item.getKey());
            Instruction call = computedCall(caller);
            recordTarget(call, stop);
            // Ghidra 12.2 records both arms of the conditional move. Keep only the no-return arm,
            // as an analysis that resolves one arm would, so the target proof alone must refuse it.
            if (item.getKey().equals("rea_conditional_call")) forgetOtherTargets(call, stop);
            if (item.getKey().endsWith("_two_targets")) recordTarget(call, function("rea_strlen"));
            if (item.getKey().endsWith("_overridden")) call.setFlowOverride(FlowOverride.CALL);
            require("computed_call_stays_open_" + item.getKey(), call.getFlowType().isCall() &&
                !call.getFlowType().isTerminal() && call.getFallThrough() != null);
            require("computed_call_recorded_targets_" + item.getKey(), callTargets(call).size() ==
                (item.getKey().endsWith("_two_targets") ? 2 : 1));
            calls.add(new ComputedCall(item.getKey(), item.getValue(), !variable.contains(item.getKey()), call.getAddress(), call.getFallThrough(),
                call.getFlowOverride(), callTargets(call), new AddressSet(caller.getBody()), pseudocode(caller)));
        }
        return calls;
    }

    private void requireComputedCalls(List<ComputedCall> calls) {
        Function stop = function("rea_computed_stop");
        require("computed_stop_keeps_flag", stop.hasNoReturn());
        for (ComputedCall saved : calls) {
            Function caller = function(saved.name());
            Instruction call = currentProgram.getListing().getInstructionAt(saved.call());
            String name = saved.name();
            require("computed_call_targets_kept_" + name, call != null && callTargets(call).equals(saved.targets()));
            if (saved.ends()) {
                require("computed_call_ended_" + name, call.getFlowOverride() == FlowOverride.CALL_RETURN &&
                    call.getFlowType().isTerminal() && call.getFallThrough() == null);
                require("computed_caller_refit_" + name, caller.getBody().getMaxAddress().equals(call.getMaxAddress()));
            } else {
                require("computed_call_kept_" + name, call.getFlowOverride() == saved.override() &&
                    !call.getFlowType().isTerminal() && saved.fallthrough().equals(call.getFallThrough()));
                require("computed_caller_body_kept_" + name, caller.getBody().equals(saved.body()));
            }
            // The decompiler already stops at a constant target and continues past the slot call.
            String after = pseudocode(caller);
            if (!after.equals(saved.pseudocode()))
                println("REA_NO_RETURN_PSEUDOCODE " + name + "\n--- before\n" + saved.pseudocode() + "\n--- after\n" + after);
            require("computed_call_pseudocode_unchanged_" + name, after.equals(saved.pseudocode()));
            require("computed_call_pseudocode_tail_" + name, after.contains("rea_after_call") != saved.constant());
        }
    }

    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length != 1) throw new IllegalArgumentException("Expected exact bridge directory");
        File directory = new File(args[0]).getCanonicalFile();
        Map<String, String> imports = Map.of(
            "rea_malloc", "malloc", "rea_tls", "__tls_get_addr",
            "rea_memcpy", "memcpy", "rea_memset", "memset",
            "rea_strlen", "strlen", "rea_errno", "__errno_location");
        for (var item : imports.entrySet()) truncate(function(item.getKey()), item.getValue());
        truncate(function("rea_tls_chain"), function("rea_tls"));
        truncate(function("rea_tls_outer"), function("rea_tls_chain"));
        function("rea_tls_outer").setNoReturn(true);
        Function adjacentCaller = function("rea_malloc_adjacent");
        truncate(adjacentCaller, "malloc");
        Address adjacentEntry = adjacentCaller.getBody().getMaxAddress().add(1);
        Function adjacent = currentProgram.getFunctionManager().createFunction(
            "rea_independent_entry", adjacentEntry,
            new AddressSet(adjacentEntry, originalEnds.get(adjacentCaller)), SourceType.USER_DEFINED);
        AddressSet adjacentBody = new AddressSet(adjacent.getBody());
        truncate(function("rea_unknown"), "rea_unknown_stop");
        external("abort").setNoReturn(true);
        external("_Unwind_Resume").setNoReturn(true);
        Function localStop = function("rea_local_stop");
        localStop.setParentNamespace(currentProgram.getSymbolTable().createNameSpace(
            currentProgram.getGlobalNamespace(), "REA_LOCAL_CONTROL", SourceType.USER_DEFINED));
        localStop.setName("malloc", SourceType.USER_DEFINED);
        localStop.setNoReturn(true);
        Function localReturn = function("rea_local_return");
        localReturn.setNoReturn(true);
        List<ComputedCall> computed = computedCalls();

        GhidraScript fix = script("ReaGhidraNoReturnFix.java", new File(directory, "ReaGhidraNoReturnFix.java"));
        Method repair = fix.getClass().getMethod("run");
        repair.invoke(fix);
        for (String name : List.of("rea_tls", "rea_tls_chain", "rea_tls_outer")) {
            Function caller = function(name);
            require("propagated_flag_repaired_" + name, !caller.hasNoReturn());
            require("propagated_body_recovered_" + name, caller.getBody().contains(originalEnds.get(caller)));
            require("propagated_signature_preserved_" + name, caller.getPrototypeString(false, true).equals(originalSignatures.get(caller)));
        }
        for (var item : imports.entrySet()) {
            Function caller = function(item.getKey());
            require("returning_import_" + item.getValue(), !external(item.getValue()).hasNoReturn());
            require("recovered_body_" + item.getValue(), caller.getBody().contains(originalEnds.get(caller)));
            require("preserved_signature_" + item.getValue(), caller.getPrototypeString(false, true).equals(originalSignatures.get(caller)));
        }
        require("abort_preserved", external("abort").hasNoReturn());
        require("unwind_preserved", external("_Unwind_Resume").hasNoReturn());
        require("unknown_import_preserved", external("rea_unknown_stop").hasNoReturn());
        require("local_name_not_whitelisted", localStop.hasNoReturn());
        require("local_return_repaired", !localReturn.hasNoReturn());
        require("independent_entry_preserved", adjacent.getBody().equals(adjacentBody) &&
            !adjacentCaller.getBody().contains(adjacentEntry));
        requireComputedCalls(computed);

        GhidraScript bridge = script("ReaGhidraBridge.java", new File(directory, "ReaGhidraBridge.java"));
        Method warnings = bridge.getClass().getDeclaredMethod(
            "functionBoundaryLimitations", Function.class, Iterable.class);
        warnings.setAccessible(true);
        Object reported = warnings.invoke(bridge, function("rea_unknown"),
            currentProgram.getListing().getInstructions(function("rea_unknown").getBody(), true));
        require("unknown_boundary_named", reported instanceof List<?> values &&
            values.stream().anyMatch(value -> value.toString().contains("rea_unknown_stop") && value.toString().contains("fallthrough")));
        Object healthy = warnings.invoke(bridge, function("rea_tls"),
            currentProgram.getListing().getInstructions(function("rea_tls").getBody(), true));
        require("healthy_boundary_no_warning", healthy instanceof List<?> values && values.isEmpty());
        Object guarded = warnings.invoke(bridge, adjacentCaller,
            currentProgram.getListing().getInstructions(adjacentCaller.getBody(), true));
        require("unrepaired_boundary_named", guarded instanceof List<?> values &&
            values.stream().anyMatch(value -> value.toString().contains("malloc")));
        Method initialize = bridge.getClass().getDeclaredMethod("initializeDecompiler");
        initialize.setAccessible(true);
        initialize.invoke(bridge);
        Method pseudocode = bridge.getClass().getDeclaredMethod("procedurePseudocode", JsonObject.class);
        pseudocode.setAccessible(true);
        JsonObject query = new JsonObject();
        query.addProperty("document", currentProgram.getName());
        query.addProperty("procedure", function("rea_tls").getName());
        var field = bridge.getClass().getDeclaredField("decompiler");
        field.setAccessible(true);
        try {
            Object output = pseudocode.invoke(bridge, query);
            require("recovered_pseudocode", output instanceof JsonObject value &&
                value.get("value").getAsString().contains("rea_after_call"));
            nonCallInstructionReference(bridge);
            knownInteriorCall(bridge);
        } finally {
            ((ghidra.app.decompiler.DecompInterface) field.get(bridge)).dispose();
        }
        Map<Function, AddressSet> bodies = new LinkedHashMap<>();
        for (var item : imports.entrySet()) bodies.put(function(item.getKey()), new AddressSet(function(item.getKey()).getBody()));
        repair.invoke(fix);
        require("idempotent_body_repair", bodies.entrySet().stream().allMatch(item -> item.getValue().equals(item.getKey().getBody())));
        JsonObject report = new JsonObject();
        report.addProperty("status", "passed");
        report.addProperty("ghidra_version", Application.getApplicationVersion());
        report.addProperty("target_sha256", currentProgram.getExecutableSHA256());
        for (String name : List.of("ReaGhidraBridge.java", "ReaGhidraNoReturnFix.java")) {
            byte[] bytes = Files.readAllBytes(new File(directory, name).toPath());
            report.addProperty(name, HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)));
        }
        report.add("checks", checks);
        println("REA_NO_RETURN_PROBE_JSON " + report);
    }
}
