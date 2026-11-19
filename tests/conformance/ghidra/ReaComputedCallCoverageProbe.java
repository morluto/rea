//@category REA Verification

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import ghidra.app.script.GhidraScript;
import ghidra.app.script.GhidraScriptUtil;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.symbol.RefType;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.SourceType;
import java.io.File;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;

/**
 * Real x86-64 decoding, functions and ReferenceManager state for calls through
 * a writable slot, a register and a direct target. Only the slot call's
 * recorded target is injected, as Ghidra's analysis records one for an
 * initialized slot. The production bridge must keep that candidate while
 * observed coverage stays complete and discovery names the unknown targets; the direct call is
 * the complete control. The source-owned bytes are never executed.
 */
public class ReaComputedCallCoverageProbe extends GhidraScript {
    private static final String COMPUTED_LIMITATION = "computed call site(s) (";

    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        require(args.length == 1, "Expected the exact production bridge directory");
        var source = GhidraScriptUtil.findScriptByName("ReaGhidraBridge.java");
        require(source != null && new File(source.getAbsolutePath()).getCanonicalFile().equals(
            new File(args[0], "ReaGhidraBridge.java").getCanonicalFile()), "Production bridge source");
        GhidraScript bridge = GhidraScriptUtil.getProvider(source).getScriptInstance(source, errorWriter);
        bridge.set(getState(), getControls());
        require(currentProgram.getLanguageID().getIdAsString().equals("x86:LE:64:default"),
            "x86-64 fixture language");
        Address base = currentProgram.getMemory().getMinAddress();
        Address selected = base;               // mov eax, 1; ret
        Address alternate = base.add(0x08);    // mov eax, 2; ret
        Address slotCaller = base.add(0x10);   // call qword ptr [rip + 0x2a] (slot at +0x40); ret
        Address registerCaller = base.add(0x18); // call rax; ret
        Address directCaller = base.add(0x20); // call selected; ret
        for (Address entry : new Address[] { selected, alternate, slotCaller, registerCaller, directCaller }) {
            if (getInstructionAt(entry) == null) disassemble(entry);
            require(getInstructionAt(entry) != null, "Decoded entry " + entry);
            require(createFunction(entry, null) != null, "Created function at " + entry);
        }
        Instruction slotCall = requireCall(slotCaller, true);
        requireCall(registerCaller, true);
        Instruction directCall = requireCall(directCaller, false);
        currentProgram.getReferenceManager().addMemoryReference(
            slotCall.getAddress(), selected, RefType.COMPUTED_CALL, SourceType.ANALYSIS, 0);
        if (!hasCallReference(directCall))
            currentProgram.getReferenceManager().addMemoryReference(
                directCall.getAddress(), selected, RefType.UNCONDITIONAL_CALL, SourceType.ANALYSIS, 0);

        Field space = bridge.getClass().getDeclaredField("sessionDefaultAddressSpace");
        space.setAccessible(true);
        space.set(null, base.getAddressSpace());
        Method callees = bridge.getClass().getDeclaredMethod("procedureCalls", JsonObject.class, boolean.class);
        callees.setAccessible(true);
        String selectedAddress = canonical(selected);

        JsonObject computed = callees(callees, bridge, slotCaller);
        require(contains(computed.getAsJsonArray("value"), selectedAddress),
            "The recorded slot target remains an observed callee");
        require(!contains(computed.getAsJsonArray("value"), canonical(alternate)),
            "No callee is invented for the alternate value");
        JsonObject computedCoverage = computed.getAsJsonObject("relationship_coverage");
        require(computedCoverage.get("status").getAsString().equals("complete"),
            "The recorded computed target inventory is complete");
        JsonObject calleeDiscovery = computedCoverage.getAsJsonObject("discovery").getAsJsonObject("callees");
        require(calleeDiscovery.get("status").getAsString().equals("unknown"), "Other computed targets stay unknown");
        require(calleeDiscovery.get("reason").getAsString().contains("1 " + COMPUTED_LIMITATION + canonical(slotCall.getAddress()) + ")"),
            "Discovery uncertainty names the computed call site");

        JsonObject targetless = callees(callees, bridge, registerCaller);
        JsonObject targetlessCoverage = targetless.getAsJsonObject("relationship_coverage");
        require(targetlessCoverage.get("status").getAsString().equals("partial"),
            "A targetless computed call keeps partial coverage");
        require(!limitationContains(targetlessCoverage, COMPUTED_LIMITATION),
            "A targetless call is not reported as having recorded candidates");

        JsonObject direct = callees(callees, bridge, directCaller);
        JsonArray directValue = direct.getAsJsonArray("value");
        require(directValue.size() == 1 && contains(directValue, selectedAddress), "Direct callee");
        require(direct.getAsJsonObject("relationship_coverage").get("status").getAsString().equals("complete"),
            "A direct call with its recorded destination stays complete");
        for (Address target : new Address[] { selected, alternate }) {
            JsonObject input = new JsonObject(); input.add("document", JsonNull.INSTANCE); input.addProperty("procedure", canonical(target));
            JsonObject incoming = (JsonObject) callees.invoke(bridge, input, true);
            JsonObject coverage = incoming.getAsJsonObject("relationship_coverage");
            require(coverage.get("status").getAsString().equals("complete"), "Recorded incoming edges remain complete");
            require(coverage.getAsJsonObject("discovery").getAsJsonObject("callers").get("status").getAsString().equals("unknown"), "Additional computed callers stay unknown");
            if (target.equals(selected)) require(contains(incoming.getAsJsonArray("value"), canonical(directCaller)), "Known direct caller survives");
            else require(incoming.getAsJsonArray("value").isEmpty(), "No alternate caller is invented");
        }
        println("REA_COMPUTED_CALL_COVERAGE_OK slot=observed-complete-discovery-unknown register=partial direct=complete callers=discovery-unknown");
    }

    private Instruction requireCall(Address entry, boolean computed) {
        Instruction instruction = getInstructionAt(entry);
        require(instruction != null && instruction.getFlowType().isCall() &&
            instruction.getFlowType().isComputed() == computed,
            (computed ? "Computed" : "Direct") + " call decoded at " + entry);
        return instruction;
    }

    private static boolean hasCallReference(Instruction instruction) {
        for (Reference reference : instruction.getReferencesFrom())
            if (reference.getReferenceType().isCall()) return true;
        return false;
    }

    private JsonObject callees(Method method, Object bridge, Address procedure) throws Exception {
        JsonObject input = new JsonObject();
        input.add("document", JsonNull.INSTANCE);
        input.addProperty("procedure", canonical(procedure));
        JsonObject result;
        try {
            result = (JsonObject) method.invoke(bridge, input, false);
        } catch (InvocationTargetException failure) {
            throw new IllegalStateException("procedure_callees failed at " + procedure, failure.getCause());
        }
        println("REA_COMPUTED_CALL_COVERAGE " + canonical(procedure) + " " + result);
        return result;
    }

    private static String canonical(Address address) {
        return "0x" + Long.toHexString(address.getOffset());
    }

    private static boolean contains(JsonArray values, String expected) {
        for (JsonElement value : values)
            if (value.getAsString().equals(expected)) return true;
        return false;
    }

    private static boolean limitationContains(JsonObject coverage, String expected) {
        JsonArray limitations = coverage.getAsJsonArray("limitations");
        if (limitations == null) return false;
        for (JsonElement limitation : limitations)
            if (limitation.getAsString().contains(expected)) return true;
        return false;
    }

    private static void require(boolean condition, String label) {
        if (!condition) throw new IllegalStateException(label);
    }
}
