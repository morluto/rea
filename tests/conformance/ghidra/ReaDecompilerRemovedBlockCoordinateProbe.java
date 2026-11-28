//@category REA Verification

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import generic.jar.ResourceFile;
import ghidra.app.decompiler.ClangCommentToken;
import ghidra.app.decompiler.ClangToken;
import ghidra.app.decompiler.ClangTokenGroup;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.decompiler.DecompiledFunction;
import ghidra.app.script.GhidraScript;
import ghidra.app.script.GhidraScriptUtil;
import ghidra.app.script.GhidraState;
import ghidra.framework.Application;
import ghidra.program.database.ProgramDB;
import ghidra.program.flatapi.FlatProgramAPI;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSet;
import ghidra.program.model.lang.Language;
import ghidra.program.model.lang.LanguageID;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Program;
import ghidra.program.model.pcode.HighFunction;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.HexFormat;

/**
 * Removal-warning coordinates through the packaged bridge's production
 * decompilerCompleteness observation, on real Ghidra address spaces that
 * analyze_function cannot reach from a source-built object: an overlay, an
 * ordinary space whose offset collides with it, unknown and non-memory spaces,
 * and AVR's word-addressed code space.
 *
 * Ghidra does not emit a removal warning for these synthetic programs, so each
 * case feeds one typed header comment token. Address resolution and listing
 * lookup are real; the warning token is not. No target code is executed.
 */
public class ReaDecompilerRemovedBlockCoordinateProbe extends GhidraScript {
    private final JsonArray checks = new JsonArray();
    private final JsonObject report = new JsonObject();
    private ResourceFile source;

    private void require(String name, boolean condition) {
        if (!condition) throw new IllegalStateException("Removed-block coordinate assertion failed: " + name);
        checks.add(name);
    }

    private static void setField(Class<?> owner, Object object, String name, Object value) throws Exception {
        Field field = owner.getDeclaredField(name);
        field.setAccessible(true);
        field.set(object, value);
    }

    private static Object invoke(GhidraScript bridge, String name, Class<?>[] types, Object... args) throws Exception {
        Method method = bridge.getClass().getDeclaredMethod(name, types);
        method.setAccessible(true);
        try { return method.invoke(bridge, args); }
        catch (InvocationTargetException exception) {
            throw new IllegalStateException("Production method failed: " + name, exception.getCause());
        }
    }

    private GhidraScript bridge(Program program) throws Exception {
        GhidraScript instance = GhidraScriptUtil.getProvider(source).getScriptInstance(source, errorWriter);
        GhidraState state = new GhidraState(getState());
        state.setCurrentProgram(program);
        instance.set(state, getControls());
        // The same coordinates and decompiler setup the bridge's run() uses.
        setField(instance.getClass(), null, "sessionDefaultAddressSpace", program.getAddressFactory().getDefaultAddressSpace());
        invoke(instance, "initializeDecompiler", new Class<?>[0]);
        return instance;
    }

    private static void close(GhidraScript bridge) throws Exception {
        if (bridge == null) return;
        Field field = bridge.getClass().getDeclaredField("decompiler");
        field.setAccessible(true);
        ((DecompInterface) field.get(bridge)).dispose();
    }

    private Function function(Program program, String name, long offset, byte[] bytes, boolean overlay) throws Exception {
        Address base = program.getAddressFactory().getDefaultAddressSpace().getAddress(offset);
        var block = program.getMemory().createInitializedBlock(name, base,
            new ByteArrayInputStream(bytes), bytes.length, monitor, overlay);
        block.setExecute(true);
        Address entry = block.getStart();
        require(name + "_disassembled", new FlatProgramAPI(program, monitor).disassemble(entry));
        return program.getFunctionManager().createFunction(name, entry,
            new AddressSet(entry, entry.add(bytes.length - 1)),
            ghidra.program.model.symbol.SourceType.USER_DEFINED);
    }

    private static ClangCommentToken comment(Address address, String text) throws Exception {
        ClangCommentToken token = new ClangCommentToken(null);
        setField(ClangCommentToken.class, token, "srcaddr", address);
        setField(ClangToken.class, token, "text", text);
        return token;
    }

    /** The real decompilation with its markup replaced by the given tokens. */
    private static DecompileResults markup(Function function, DecompileResults original, ClangTokenGroup tokens) {
        Program program = function.getProgram();
        return new DecompileResults(function, program.getLanguage(), program.getCompilerSpec(), null, "", null, null) {
            @Override public HighFunction getHighFunction() { return original.getHighFunction(); }
            @Override public ClangTokenGroup getCCodeMarkup() { return tokens; }
            @Override public DecompiledFunction getDecompiledFunction() { return original.getDecompiledFunction(); }
        };
    }

    /**
     * Feed one header removal warning, in the decompiler's raw
     * "<space>,<word offset>" spelling, and return its single dropped block.
     */
    private JsonObject droppedBlock(GhidraScript bridge, Function function, String space, String reported) throws Exception {
        DecompileResults decompiled = (DecompileResults) invoke(bridge, "decompile", new Class<?>[] { Function.class }, function);
        require(function.getName() + "_decompiled", decompiled != null && decompiled.getDecompiledFunction() != null);
        ClangTokenGroup group = new ClangTokenGroup(null);
        group.AddTokenGroup(comment(function.getEntryPoint(),
            "/* WARNING: Removing unreachable block (" + space + "," + reported + ") */"));
        Object observed = invoke(bridge, "decompilerCompleteness",
            new Class<?>[] { Function.class, DecompileResults.class, String.class },
            function, markup(function, decompiled, group), "");
        Method accessor = observed.getClass().getDeclaredMethod("observation");
        accessor.setAccessible(true);
        JsonArray dropped = ((JsonObject) accessor.invoke(observed)).getAsJsonArray("dropped_blocks");
        require(function.getName() + "_" + space + "_one_dropped_block", dropped.size() == 1);
        return dropped.get(0).getAsJsonObject();
    }

    private void droppedAt(String name, JsonObject block, String start, boolean listing) {
        require(name + "_dropped_start", start == null
            ? block.get("start").isJsonNull()
            : !block.get("start").isJsonNull() && block.get("start").getAsString().equals(start));
        require(name + "_end_unknown", block.get("end").isJsonNull());
        require(name + "_listing_block", block.has("listing_block") == listing);
    }

    private void aarch64() throws Exception {
        Language language = getLanguage(new LanguageID("AARCH64:LE:64:v8A"));
        ProgramDB program = new ProgramDB("aarch64-removed-block-fixture", language, language.getDefaultCompilerSpec(), this);
        int transaction = program.startTransaction("source-owned instruction fixtures");
        GhidraScript bridge = null;
        try {
            // mov w0,#0x2a; nop; nop; mov w0,#0x77; ret: offset 0xc lies inside the body.
            byte[] bytes = HexFormat.of().parseHex("40058052" + "1f2003d5" + "1f2003d5" + "e00e8052" + "c0035fd6");
            Function ordinary = function(program, "aarch64_default", 0x1000, bytes, false);
            Function overlay = function(program, "aarch64_overlay", 0x1000, bytes, true);
            bridge = bridge(program);
            // Removal warnings print their space, so an overlay keeps its identity
            // and an ordinary space with the same offset stays distinct.
            String overlaySpace = overlay.getEntryPoint().getAddressSpace().getName();
            droppedAt("overlay_removal", droppedBlock(bridge, overlay, overlaySpace, "0x0000100c"),
                overlaySpace + ":0x100c", true);
            droppedAt("default_removal", droppedBlock(bridge, ordinary, "ram", "0x0000100c"), "0x100c", true);
            // The ordinary function's body does not contain the overlay start.
            droppedAt("colliding_overlay_removal", droppedBlock(bridge, ordinary, overlaySpace, "0x0000100c"),
                overlaySpace + ":0x100c", false);
            droppedAt("unknown_space_removal", droppedBlock(bridge, ordinary, "rea_no_such_space", "0x0000100c"),
                null, false);
            droppedAt("register_space_removal", droppedBlock(bridge, ordinary, "register", "0x0"), null, false);
            // A start outside the function body resolves but has no listing block.
            droppedAt("outside_body_removal", droppedBlock(bridge, ordinary, "ram", "0x00002000"), "0x2000", false);
        } finally {
            close(bridge);
            program.endTransaction(transaction, false);
            program.release(this);
        }
    }

    private void avr() throws Exception {
        Language language = getLanguage(new LanguageID("avr8:LE:16:default"));
        ProgramDB program = new ProgramDB("avr-removed-block-fixture", language, language.getDefaultCompilerSpec(), this);
        int transaction = program.startTransaction("source-owned instruction fixture");
        GhidraScript bridge = null;
        try {
            // ldi r24,0x2a; nop; nop; nop; ldi r24,0x77; ret: byte 0x1008 is word 0x0804.
            byte[] bytes = HexFormat.of().parseHex("8ae2" + "0000" + "0000" + "0000" + "87e7" + "0895");
            Function function = function(program, "avr_word_addressed", 0x1000, bytes, false);
            require("avr_two_byte_addressable_unit", function.getEntryPoint().getAddressSpace().getAddressableUnitSize() == 2);
            bridge = bridge(program);
            String codeSpace = function.getEntryPoint().getAddressSpace().getName();
            JsonObject word = droppedBlock(bridge, function, codeSpace, "0x0804");
            // Compare REA's own canonical spelling: Ghidra's AddressFactory parses
            // AVR code offsets in words, so it cannot read a byte coordinate back.
            String byteAddress = (String) invoke(bridge, "canonicalAddress",
                new Class<?>[] { Address.class }, function.getEntryPoint().add(8));
            report.addProperty("avr_word_removal_start", word.get("start").isJsonNull() ? null : word.get("start").getAsString());
            droppedAt("avr_word_removal", word, byteAddress, true);
            require("avr_word_removal_raw_offset", word.get("reported_offset").getAsString().equals("0x0804"));
        } finally {
            close(bridge);
            program.endTransaction(transaction, false);
            program.release(this);
        }
    }

    @Override public void run() throws Exception {
        if (getScriptArgs().length != 1) throw new IllegalArgumentException("Pass the exact bridge source path");
        File expected = new File(getScriptArgs()[0]).getCanonicalFile();
        source = GhidraScriptUtil.findScriptByName("ReaGhidraBridge.java");
        if (source == null || !expected.equals(new File(source.getAbsolutePath()).getCanonicalFile()))
            throw new IllegalStateException("Bridge source resolution differs from the requested source");
        aarch64();
        avr();
        report.addProperty("schema_version", 1);
        report.addProperty("status", "passed");
        report.addProperty("ghidra_version", Application.getApplicationVersion());
        report.addProperty("bridge_source_sha256", HexFormat.of().formatHex(
            MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(expected.toPath()))));
        report.add("checks", checks);
        report.addProperty("scope", "synthetic ProgramDB address spaces with one typed header warning token each; no target execution");
        println("REA_REMOVED_BLOCK_COORDINATE_PROBE_JSON " + report);
    }
}
