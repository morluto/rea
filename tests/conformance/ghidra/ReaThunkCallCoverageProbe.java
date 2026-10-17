//@category REA Verification

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import generic.jar.ResourceFile;
import ghidra.app.script.GhidraScript;
import ghidra.app.script.GhidraScriptUtil;
import ghidra.framework.Application;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.symbol.RefType;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.SourceType;
import java.io.File;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;

/**
 * Moves the shared-thunks fixture's PLT call from the thunk's entry into its
 * body, where getCallingFunctions does not look, and checks that the bridge
 * reports the omission as partial caller coverage. Never executes target code.
 */
public class ReaThunkCallCoverageProbe extends GhidraScript {
    private record MemoryCallReference(Address source, Address target, RefType type,
        SourceType sourceType, int operandIndex, boolean primary) {}

    private final JsonArray checks = new JsonArray();

    private void require(String name, boolean condition) {
        require(name, condition, "");
    }

    private void require(String name, boolean condition, Object observed) {
        if (!condition)
            throw new IllegalStateException("Thunk call coverage assertion failed: " + name + " " + observed);
        checks.add(name);
    }

    private Function function(String name, boolean thunk) {
        for (Function f : currentProgram.getFunctionManager().getFunctions(true))
            if (f.isThunk() == thunk && f.getName().equals(name)) return f;
        throw new IllegalStateException("Missing fixture " + (thunk ? "thunk " : "function ") + name);
    }

    private GhidraScript script(String name, File expected) throws Exception {
        ResourceFile source = GhidraScriptUtil.findScriptByName(name);
        if (source == null || !expected.equals(new File(source.getAbsolutePath()).getCanonicalFile()))
            throw new IllegalStateException("Fixture resolved an unexpected script: " + name);
        GhidraScript instance = GhidraScriptUtil.getProvider(source).getScriptInstance(source, errorWriter);
        instance.set(getState(), getControls());
        return instance;
    }

    private static String address(Function function) {
        return "0x" + Long.toHexString(function.getEntryPoint().getOffset());
    }

    private static JsonObject coverage(JsonObject observation) {
        return observation.getAsJsonObject("relationship_coverage");
    }

    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length != 1) throw new IllegalArgumentException("Expected exact bridge directory");
        File directory = new File(args[0]).getCanonicalFile();
        Function leaf = function("rea_ghidra_shared_leaf", false);
        Function thunk = function("rea_ghidra_shared_leaf", true);
        Function entry = function("rea_ghidra_shared_entry", false);
        require("thunk_targets_leaf", leaf.equals(thunk.getThunkedFunction(true)));
        Address interior = thunk.getEntryPoint().add(1);
        require("interior_is_thunk_body", thunk.getBody().contains(interior) &&
            currentProgram.getFunctionManager().getFunctionAt(interior) == null);

        GhidraScript bridge = script("ReaGhidraBridge.java", new File(directory, "ReaGhidraBridge.java"));
        Method initialize = bridge.getClass().getDeclaredMethod("initializeDecompiler");
        initialize.setAccessible(true);
        initialize.invoke(bridge);
        var decompiler = bridge.getClass().getDeclaredField("decompiler");
        decompiler.setAccessible(true);
        try {
            probe(bridge, leaf, thunk, entry, interior);
        } finally {
            ((ghidra.app.decompiler.DecompInterface) decompiler.get(bridge)).dispose();
        }

        JsonObject report = new JsonObject();
        report.addProperty("status", "passed");
        report.addProperty("ghidra_version", Application.getApplicationVersion());
        report.addProperty("target_sha256", currentProgram.getExecutableSHA256());
        byte[] bytes = Files.readAllBytes(new File(directory, "ReaGhidraBridge.java").toPath());
        report.addProperty("ReaGhidraBridge.java",
            HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)));
        report.add("checks", checks);
        println("REA_THUNK_CALL_COVERAGE_PROBE_JSON " + report);
    }

    private void probe(GhidraScript bridge, Function leaf, Function thunk, Function entry, Address interior)
            throws Exception {
        Method calls = bridge.getClass().getDeclaredMethod("procedureCalls", JsonObject.class, boolean.class);
        calls.setAccessible(true);
        Method analyze = bridge.getClass().getDeclaredMethod("analyzeFunctionObservation", JsonObject.class);
        analyze.setAccessible(true);
        JsonObject query = new JsonObject();
        query.addProperty("document", currentProgram.getName());
        query.addProperty("procedure", address(leaf));
        JsonObject dossierQuery = new JsonObject();
        dossierQuery.addProperty("procedure", address(leaf));

        JsonObject folded = (JsonObject) calls.invoke(bridge, query, true);
        Method canonical = bridge.getClass().getDeclaredMethod("canonicalAddress", Address.class);
        canonical.setAccessible(true);
        String entryCaller = "[\"" + canonical.invoke(null, entry.getEntryPoint()) + "\"]";
        require("entry_call_folded_into_callers",
            folded.getAsJsonArray("value").toString().equals(entryCaller), folded);
        require("entry_call_coverage_complete", coverage(folded).get("status").getAsString().equals("complete"), folded);

        Instruction call = null;
        for (Instruction instruction : currentProgram.getListing().getInstructions(entry.getBody(), true)) {
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
        require("original_call_targets_thunk", originals.size() == 1 &&
            originals.get(0).getToAddress().equals(thunk.getEntryPoint()));
        Reference changed = null;
        try {
            for (Reference reference : originals) references.delete(reference);
            changed = references.addMemoryReference(call.getAddress(), interior,
                RefType.UNCONDITIONAL_CALL, SourceType.USER_DEFINED, 0);
            require("interior_caller_omitted_by_entry_getter", !thunk.getCallingFunctions(monitor).contains(entry));
            JsonObject omitted = (JsonObject) calls.invoke(bridge, query, true);
            require("interior_caller_not_listed", omitted.getAsJsonArray("value").isEmpty(), omitted);
            require("interior_caller_coverage_partial",
                coverage(omitted).get("status").getAsString().equals("partial"), omitted);
            require("interior_caller_direction_explicit",
                coverage(omitted).getAsJsonArray("limited_directions").toString().equals("[\"callers\"]"), omitted);
            Object observation = analyze.invoke(bridge, dossierQuery);
            Method relationship = observation.getClass().getDeclaredMethod("relationshipCoverage");
            relationship.setAccessible(true);
            JsonObject dossier = (JsonObject) relationship.invoke(observation);
            require("dossier_interior_caller_partial", dossier.get("status").getAsString().equals("partial") &&
                dossier.getAsJsonArray("limited_directions").toString().equals("[\"callers\"]"), dossier);
        } finally {
            if (changed != null) references.delete(changed);
            for (MemoryCallReference reference : saved) {
                Reference restored = references.addMemoryReference(reference.source(), reference.target(),
                    reference.type(), reference.sourceType(), reference.operandIndex());
                references.setPrimary(restored, reference.primary());
            }
        }
        JsonObject restored = (JsonObject) calls.invoke(bridge, query, true);
        require("restored_call_complete", coverage(restored).get("status").getAsString().equals("complete") &&
            restored.getAsJsonArray("value").toString().equals(entryCaller), restored);
    }
}
