//@category REA Verification

import com.google.gson.JsonObject;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.app.script.GhidraScriptUtil;
import ghidra.program.model.address.Address;
import ghidra.program.model.data.IntegerDataType;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Parameter;
import ghidra.program.model.listing.ParameterImpl;
import ghidra.program.model.symbol.SourceType;
import java.io.File;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;

/**
 * Real x86-64 decoding, function signatures and decompilation. Two functions
 * keep Ghidra's default signature, one without and one with used argument
 * registers; three get user-defined int f(void), int f(...) and int f(int x)
 * signatures, as an analyst would author them. The production bridge must
 * report each HighFunction's parameter-list basis and varargs flag, with the
 * value-flow parameters matching the API boundary. The bytes are never executed.
 */
public class ReaParameterListProbe extends GhidraScript {
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
        Function defaultEmpty = function(base);           // mov eax, 1; ret
        Function userVoid = function(base.add(0x08));      // mov eax, 1; ret
        Function userVarargs = function(base.add(0x10));   // mov eax, 1; ret
        Function userOne = function(base.add(0x18));       // mov eax, 1; ret
        Function defaultUsed = function(base.add(0x20));   // lea eax, [rdi + rcx]; ret
        author(userVoid, false);
        author(userVarargs, true);
        author(userOne, false, new ParameterImpl("x", IntegerDataType.dataType, currentProgram));
        require(defaultEmpty.getSignatureSource() == SourceType.DEFAULT &&
            defaultUsed.getSignatureSource() == SourceType.DEFAULT, "Default fixture signatures");

        Field space = bridge.getClass().getDeclaredField("sessionDefaultAddressSpace");
        space.setAccessible(true);
        space.set(null, base.getAddressSpace());
        Field timeout = bridge.getClass().getDeclaredField("decompileTimeoutSeconds");
        timeout.setAccessible(true);
        timeout.setInt(bridge, 60);
        Field decompiler = bridge.getClass().getDeclaredField("decompiler");
        decompiler.setAccessible(true);
        invoke(method(bridge, "initializeDecompiler"), bridge);
        Method decompile = method(bridge, "decompile", Function.class);
        Method boundary = method(bridge, "nativeApiBoundary", Function.class, DecompileResults.class);
        Method flow = method(bridge, "nativeValueFlow", DecompileResults.class);
        try {
            // -1 requires at least one recovered parameter; its basis is the fact under test.
            check(bridge, decompile, boundary, flow, defaultEmpty, "recovered", false, 0);
            check(bridge, decompile, boundary, flow, userVoid, "signature", false, 0);
            check(bridge, decompile, boundary, flow, userVarargs, "signature", true, 0);
            check(bridge, decompile, boundary, flow, userOne, "signature", false, 1);
            check(bridge, decompile, boundary, flow, defaultUsed, "recovered", false, -1);
        } finally {
            ((DecompInterface) decompiler.get(bridge)).dispose();
        }
        println("REA_PARAMETER_LIST_OK default=recovered void=signature varargs=variadic one=signature used=recovered");
    }

    private Function function(Address entry) throws Exception {
        if (getInstructionAt(entry) == null) disassemble(entry);
        require(getInstructionAt(entry) != null, "Decoded entry " + entry);
        Function function = createFunction(entry, null);
        require(function != null, "Created function at " + entry);
        return function;
    }

    private static void author(Function function, boolean varargs, Parameter... parameters)
            throws Exception {
        function.setReturnType(IntegerDataType.dataType, SourceType.USER_DEFINED);
        function.replaceParameters(Function.FunctionUpdateType.DYNAMIC_STORAGE_ALL_PARAMS, true,
            SourceType.USER_DEFINED, parameters);
        function.setVarArgs(varargs);
        require(function.getSignatureSource() == SourceType.USER_DEFINED &&
            function.getParameterCount() == parameters.length && function.hasVarArgs() == varargs,
            "Authored signature " + function.getSignature().getPrototypeString());
    }

    private void check(Object bridge, Method decompile, Method boundary, Method flow,
            Function function, String basis, boolean variadic, int parameters) throws Exception {
        DecompileResults results = (DecompileResults) invoke(decompile, bridge, function);
        JsonObject api = (JsonObject) invoke(boundary, bridge, function, results);
        JsonObject values = (JsonObject) invoke(flow, bridge, results);
        String label = function.getSignature().getPrototypeString();
        println("REA_PARAMETER_LIST " + label + " " + api.get("parameter_list") +
            " parameters=" + api.getAsJsonArray("parameters").size());
        require(api.get("available").getAsBoolean(), "Available API boundary for " + label);
        JsonObject list = api.getAsJsonObject("parameter_list");
        require(list != null && list.get("basis").getAsString().equals(basis),
            "Parameter-list basis " + basis + " for " + label);
        require(list.get("variadic").getAsBoolean() == variadic,
            "Varargs flag " + variadic + " for " + label);
        int count = api.getAsJsonArray("parameters").size();
        require(parameters < 0 ? count > 0 : count == parameters, "Parameter count for " + label);
        require(values.get("available").getAsBoolean() &&
            values.getAsJsonArray("parameters").size() == count,
            "Value-flow parameters match the API boundary for " + label);
    }

    private static Method method(Object owner, String name, Class<?>... types)
            throws NoSuchMethodException {
        Method method = owner.getClass().getDeclaredMethod(name, types);
        method.setAccessible(true);
        return method;
    }

    private static Object invoke(Method method, Object owner, Object... values) throws Exception {
        try { return method.invoke(owner, values); }
        catch (InvocationTargetException failure) {
            if (failure.getCause() instanceof Exception cause) throw cause;
            throw failure;
        }
    }

    private static void require(boolean condition, String label) {
        if (!condition) throw new IllegalStateException(label);
    }
}
