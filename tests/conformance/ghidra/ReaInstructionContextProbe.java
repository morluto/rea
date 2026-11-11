//@category REA Verification

import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import ghidra.app.script.GhidraScript;
import ghidra.app.script.GhidraScriptUtil;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Program;
import ghidra.program.model.listing.ProgramContext;
import java.io.File;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.math.BigInteger;

/** Real ARM/Thumb decoding; only the unavailable context value is injected. */
public class ReaInstructionContextProbe extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        require(args.length == 1 || (args.length == 2 && args[1].equals("mips")), "Expected the bridge directory and optional MIPS mode");
        var source = GhidraScriptUtil.findScriptByName("ReaGhidraBridge.java");
        require(source != null && new File(source.getAbsolutePath()).getCanonicalFile().equals(
            new File(args[0], "ReaGhidraBridge.java").getCanonicalFile()), "Production bridge source");
        GhidraScript bridge = GhidraScriptUtil.getProvider(source).getScriptInstance(source, errorWriter);
        bridge.set(getState(), getControls());
        if (args.length == 2) {
            checkMips(bridge);
            return;
        }
        require(currentProgram.getLanguageID().getIdAsString().equals("ARM:LE:32:v7"), "ARM fixture language");
        var mode = currentProgram.getRegister("TMode");
        require(mode != null, "Real TMode register");
        Address arm = currentProgram.getMemory().getMinAddress();
        Address thumb = arm.add(4);
        var context = currentProgram.getProgramContext();
        context.setValue(mode, arm, arm.add(3), BigInteger.ZERO);
        context.setValue(mode, thumb, thumb.add(1), BigInteger.ONE);
        require(disassemble(arm), "ARM instruction decoded");
        require(disassemble(thumb), "Thumb instruction decoded");
        Field space = bridge.getClass().getDeclaredField("sessionDefaultAddressSpace");
        space.setAccessible(true);
        space.set(null, arm.getAddressSpace());
        Method inspect = bridge.getClass().getDeclaredMethod("inspectNativeInstruction", JsonObject.class, boolean.class);
        inspect.setAccessible(true);
        check(inspect, bridge, arm, "0", 4, "1eff2fe1", "TMode");
        check(inspect, bridge, thumb, "1", 2, "7047", "TMode");

        // getValue includes language defaults. Inject only its unavailable result,
        // preserving the real instruction, register, language and all other APIs.
        Program original = currentProgram;
        ProgramContext unavailable = (ProgramContext) Proxy.newProxyInstance(
            ProgramContext.class.getClassLoader(), new Class<?>[] { ProgramContext.class },
            (proxy, method, values) -> method.getName().equals("getValue") && mode.equals(values[0])
                ? null : invoke(method, context, values));
        Program program = (Program) Proxy.newProxyInstance(Program.class.getClassLoader(),
            new Class<?>[] { Program.class }, (proxy, method, values) ->
                method.getName().equals("getProgramContext") ? unavailable : invoke(method, original, values));
        Field programField = field(bridge.getClass(), "currentProgram");
        programField.setAccessible(true);
        try {
            programField.set(bridge, program);
            check(inspect, bridge, arm, null, 4, "1eff2fe1", "TMode");
        } finally {
            programField.set(bridge, original);
        }
        println("REA_ARM_CONTEXT_OK arm=0 thumb=1 unavailable=null (injected provider value)");
    }

    private void checkMips(GhidraScript bridge) throws Exception {
        require(currentProgram.getLanguageID().getIdAsString().equals("MIPS:LE:32:default"), "MIPS fixture language");
        var mode = currentProgram.getRegister("ISA_MODE");
        require(mode != null, "Real ISA_MODE register");
        Address standard = currentProgram.getMemory().getMinAddress();
        Address compressed = standard.add(4);
        var context = currentProgram.getProgramContext();
        context.setValue(mode, standard, standard.add(3), BigInteger.ZERO);
        require(disassemble(standard), "MIPS32 instruction decoded");
        // MIPS32 flow may have decoded following bytes in the default mode.
        clearListing(compressed, compressed.add(3));
        context.setValue(mode, compressed, compressed.add(1), BigInteger.ONE);
        require(disassemble(compressed), "MIPS16 instruction decoded");
        Field space = bridge.getClass().getDeclaredField("sessionDefaultAddressSpace");
        space.setAccessible(true);
        space.set(null, standard.getAddressSpace());
        Method inspect = bridge.getClass().getDeclaredMethod("inspectNativeInstruction", JsonObject.class, boolean.class);
        inspect.setAccessible(true);
        check(inspect, bridge, standard, "0", 4, "03008224", "ISA_MODE");
        check(inspect, bridge, compressed, "1", 2, "5a6a", "ISA_MODE");
        println("REA_MIPS_CONTEXT_OK standard=0 mips16=1");
    }

    private static void check(Method inspect, Object bridge, Address address, String mode,
            int length, String bytes, String register) throws Exception {
        JsonObject input = new JsonObject();
        input.add("document", JsonNull.INSTANCE);
        input.addProperty("address", "0x" + Long.toUnsignedString(address.getOffset(), 16));
        JsonObject result = (JsonObject) inspect.invoke(bridge, input, false);
        require(result.get("status").getAsString().equals("decoded"), "Decoded bridge response: " + result);
        require(result.get("length").getAsInt() == length, "Instruction width");
        require(result.get("bytes").getAsString().equals(bytes), "Original instruction bytes");
        var contexts = result.getAsJsonArray("decoder_context");
        require(contexts != null && contexts.size() == 1, "One retained mode context");
        var value = contexts.get(0).getAsJsonObject();
        require(value.get("register").getAsString().equals(register), "Exact context register name");
        require(value.get("source").getAsString().equals("ghidra-program-context"), "Context provenance");
        require(mode == null ? value.get("value").isJsonNull()
            : mode.equals(value.get("value").getAsString()), "Exact mode value " + mode);
    }

    private static Object invoke(Method method, Object owner, Object[] values) throws Throwable {
        try { return method.invoke(owner, values); }
        catch (InvocationTargetException failure) { throw failure.getCause(); }
    }

    private static Field field(Class<?> owner, String name) throws NoSuchFieldException {
        for (Class<?> type = owner; type != null; type = type.getSuperclass()) {
            try { return type.getDeclaredField(name); }
            catch (NoSuchFieldException absent) { /* Check the inherited API owner. */ }
        }
        throw new NoSuchFieldException(name);
    }

    private static void require(boolean condition, String label) {
        if (!condition) throw new IllegalStateException(label);
    }
}
