//@category REA Verification

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import generic.jar.ResourceFile;
import ghidra.app.decompiler.ClangCommentToken;
import ghidra.app.decompiler.ClangNode;
import ghidra.app.decompiler.ClangToken;
import ghidra.app.decompiler.ClangTokenGroup;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileOptions;
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
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.Program;
import ghidra.program.model.pcode.HighFunction;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;

/**
 * Real decompilations of source-owned instructions, followed by detached markup
 * controls at the same producer boundary. No target code is executed or imported.
 * Reflection calls the packaged bridge; it does not reimplement its projection.
 */
public class ReaIndirectBranchEvidenceProbe extends GhidraScript {
    private final JsonArray checks = new JsonArray();
    private final JsonArray cases = new JsonArray();
    private ResourceFile source;

    private void require(String name, boolean condition) {
        if (!condition) throw new IllegalStateException("Indirect-branch assertion failed: " + name);
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
        // These are the same coordinates and decompiler setup used by run().
        setField(instance.getClass(), null, "sessionDefaultAddressSpace", program.getAddressFactory().getDefaultAddressSpace());
        invoke(instance, "initializeDecompiler", new Class<?>[0]);
        return instance;
    }

    private static DecompInterface decompiler(GhidraScript bridge) throws Exception {
        Field field = bridge.getClass().getDeclaredField("decompiler");
        field.setAccessible(true);
        return (DecompInterface) field.get(bridge);
    }

    private static void close(GhidraScript bridge) throws Exception {
        if (bridge != null) decompiler(bridge).dispose();
    }

    private Function function(Program program, String name, long offset, byte[] bytes, boolean overlay, int returnOffset) throws Exception {
        Address base = program.getAddressFactory().getDefaultAddressSpace().getAddress(offset);
        var block = program.getMemory().createInitializedBlock(name, base,
            new ByteArrayInputStream(bytes), bytes.length, monitor, overlay);
        block.setExecute(true);
        Address entry = block.getStart();
        FlatProgramAPI api = new FlatProgramAPI(program, monitor);
        require(name + "_disassembled", api.disassemble(entry));
        if (returnOffset >= 0) api.disassemble(entry.add(returnOffset));
        return program.getFunctionManager().createFunction(name, entry,
            new AddressSet(entry, entry.add(bytes.length - 1)),
            ghidra.program.model.symbol.SourceType.USER_DEFINED);
    }

    private JsonObject boundary(GhidraScript bridge, Function function, DecompileResults result) throws Exception {
        return (JsonObject) invoke(bridge, "nativeApiBoundary",
            new Class<?>[] { Function.class, DecompileResults.class }, function, result);
    }

    private JsonObject branch(JsonObject boundary, String address) {
        JsonArray branches = boundary.getAsJsonArray("unresolved_indirect_branches");
        require(address + "_one_computed_jump", branches.size() == 1);
        JsonObject branch = branches.get(0).getAsJsonObject();
        require(address + "_exact_branch_address", branch.get("branch_address").getAsString().equals(address));
        require(address + "_targets_stay_unknown", branch.getAsJsonArray("listing_targets").isEmpty());
        require(address + "_no_recovered_table", boundary.getAsJsonArray("jump_tables").isEmpty());
        return branch;
    }

    private void outcome(String name, JsonObject branch, String expected) {
        require(name + "_outcome", branch.get("decompiler_outcome").getAsString().equals(expected));
        boolean warning = branch.getAsJsonArray("evidence").asList().stream().anyMatch(
            item -> item.getAsJsonObject().get("source").getAsString().equals("ghidra-decompiler-warning"));
        require(name + "_warning_evidence", warning == expected.equals("jump_table_recovery_failed"));
    }

    private DecompileResults observed(GhidraScript bridge, Function function, int branchOffset, String expectedAddress) throws Exception {
        Program program = function.getProgram();
        Address site = function.getEntryPoint().add(branchOffset);
        Instruction instruction = program.getListing().getInstructionAt(site);
        require(function.getName() + "_non_entry_computed_jump", branchOffset > 0 && instruction != null &&
            instruction.getFlowType().isJump() && instruction.getFlowType().isComputed() && !instruction.isInDelaySlot());
        DecompileResults result = (DecompileResults) invoke(bridge, "decompile", new Class<?>[] { Function.class }, function);
        require(function.getName() + "_real_warning", result.getDecompiledFunction().getC().replaceAll("\\s+", " ").contains("WARNING: Could not recover jumptable at "));
        List<ClangNode> tokens = new ArrayList<>();
        result.getCCodeMarkup().flatten(tokens);
        require(function.getName() + "_typed_warning_site", tokens.stream().anyMatch(node ->
            node instanceof ClangCommentToken comment && comment.getText().equals("jumptable") &&
                site.equals(comment.getMinAddress()) && site.equals(comment.getMaxAddress())));
        JsonObject nativeApi = boundary(bridge, function, result);
        outcome(function.getName(), branch(nativeApi, expectedAddress), "jump_table_recovery_failed");
        JsonObject observation = new JsonObject();
        observation.addProperty("name", function.getName());
        observation.addProperty("language_id", program.getLanguageID().toString());
        observation.addProperty("addressable_unit_bytes", site.getAddressSpace().getAddressableUnitSize());
        observation.addProperty("branch_address", expectedAddress);
        observation.addProperty("displayed_branch_address", site.toString());
        observation.add("native_api", nativeApi);
        // Full dossiers deliberately require byte-addressed function bodies.
        // The AVR case exercises this reusable producer, not new target admission.
        if (site.getAddressSpace().getAddressableUnitSize() == 1) {
            JsonObject parameters = new JsonObject();
            parameters.addProperty("procedure", function.getName());
            JsonObject dossier = (JsonObject) invoke(bridge, "analyzeFunction", new Class<?>[] { JsonObject.class }, parameters);
            require(function.getName() + "_dossier_preserves_boundary", nativeApi.equals(dossier.getAsJsonObject("native_api")));
            observation.add("dossier", dossier);
        }
        cases.add(observation);
        return result;
    }

    private ClangCommentToken comment(Address address, String text) throws Exception {
        ClangCommentToken token = new ClangCommentToken(null);
        setField(ClangCommentToken.class, token, "srcaddr", address);
        setField(ClangToken.class, token, "text", text);
        return token;
    }

    private static DecompileResults markup(Function function, DecompileResults original, ClangTokenGroup tokens) {
        Program program = function.getProgram();
        return new DecompileResults(function, program.getLanguage(), program.getCompilerSpec(), null, "", null, null) {
            @Override public HighFunction getHighFunction() { return original.getHighFunction(); }
            @Override public ClangTokenGroup getCCodeMarkup() { return tokens; }
            // Keep the real warning-looking pseudocode: absence of typed provenance
            // must not silently fall back to a text-only coordinate guess.
            @Override public DecompiledFunction getDecompiledFunction() { return original.getDecompiledFunction(); }
        };
    }

    private void control(String name, GhidraScript bridge, Function function, DecompileResults result, ClangNode... nodes) throws Exception {
        ClangTokenGroup group = new ClangTokenGroup(null);
        for (ClangNode node : nodes) group.AddTokenGroup(node);
        JsonObject actual = branch(boundary(bridge, function, markup(function, result, group)), "0x100c");
        outcome(name, actual, "no_jump_table_warning");
    }

    private void aarch64() throws Exception {
        Language language = getLanguage(new LanguageID("AARCH64:LE:64:v8A"));
        ProgramDB program = new ProgramDB("aarch64-warning-fixture", language, language.getDefaultCompilerSpec(), this);
        int transaction = program.startTransaction("source-owned instruction fixtures");
        GhidraScript bridge = null;
        try {
            // mov w1,wzr; adr x8,entry+16; add x8,x8,x0,lsl#3; br x8;
            // add w1,w1,#1; nop; add w1,w1,#1; nop; mov w0,w1; ret.
            byte[] bytes = HexFormat.of().parseHex("e1031f2a68000010080d008b00011fd6210400111f2003d5210400111f2003d5e003012ac0035fd6");
            Function ordinary = function(program, "aarch64_default", 0x1000, bytes, false, 36);
            Function overlay = function(program, "aarch64_overlay", 0x1000, bytes, true, 36);
            // b entry+4; ret. A direct jump and return are not computed jumps.
            Function direct = function(program, "direct_and_return", 0x2000, HexFormat.of().parseHex("01000014c0035fd6"), false, 4);
            // blr x16; ret. An indirect call is not a computed jump.
            Function call = function(program, "indirect_call", 0x2010, HexFormat.of().parseHex("00023fd6c0035fd6"), false, 4);
            bridge = bridge(program);
            DecompileResults result = observed(bridge, ordinary, 12, "0x100c");
            observed(bridge, overlay, 12, "aarch64_overlay:0x100c");
            for (Function excluded : List.of(direct, call)) {
                DecompileResults decompiled = (DecompileResults) invoke(bridge, "decompile", new Class<?>[] { Function.class }, excluded);
                require(excluded.getName() + "_excluded", boundary(bridge, excluded, decompiled).getAsJsonArray("unresolved_indirect_branches").isEmpty());
            }
            Address site = ordinary.getEntryPoint().add(12);
            String warning = "/* WARNING: Could not recover jumptable at 0x0000100c. Too many branches */";
            control("absent_markup", bridge, ordinary, result);
            outcome("null_markup", branch(boundary(bridge, ordinary, markup(ordinary, result, null)), "0x100c"), "no_jump_table_warning");
            control("warning_string_literal", bridge, ordinary, result, new ClangToken(null, '"' + warning + '"', ClangToken.CONST_COLOR));
            control("missing_comment_source", bridge, ordinary, result, comment(null, warning));
            control("other_instruction", bridge, ordinary, result, comment(site.add(4), warning));
            control("colliding_overlay_offset", bridge, ordinary, result, comment(overlay.getEntryPoint().add(12), warning));
            control("separate_comments", bridge, ordinary, result,
                comment(site, "/* WARNING: Could not */"), comment(site, "/* recover jumptable at 0x100c */"));
            control("mixed_comment_sources", bridge, ordinary, result,
                comment(site, "/* WARNING: Could not recover"), comment(site.add(4), "jumptable at 0x100c */"));
            control("incomplete_comment", bridge, ordinary, result,
                comment(site, "/* WARNING: Could not recover jumptable at 0x100c"));
        } finally {
            close(bridge);
            program.endTransaction(transaction, false);
            program.release(this);
        }
    }

    private void otherArchitectures() throws Exception {
        for (String languageId : List.of("avr8:LE:16:default", "MIPS:LE:32:default")) {
            Language language = getLanguage(new LanguageID(languageId));
            ProgramDB program = new ProgramDB("warning-fixture", language, language.getDefaultCompilerSpec(), this);
            int transaction = program.startTransaction("source-owned instruction fixture");
            GhidraScript bridge = null;
            try {
                boolean avr = languageId.startsWith("avr8:");
                byte[] bytes;
                if (avr) {
                    // ldi r30,0x10; ldi r31,0x08; add r30,r24; adc r31,r25; ijmp.
                    // A separate ret at byte offset32 remains a listing return control.
                    bytes = new byte[34];
                    System.arraycopy(HexFormat.of().parseHex("e0e1f8e0e80ff91f0994"), 0, bytes, 0, 10);
                    bytes[32] = 0x08;
                    bytes[33] = (byte) 0x95;
                } else {
                    // sll t0,a0,2; addu t9,a1,t0; jr t9; nop; jr ra; nop.
                    bytes = HexFormat.of().parseHex("8040040021c8a80008002003000000000800e00300000000");
                }
                Function function = function(program, avr ? "avr_word_addressed" : "mips_delay_slot",
                    avr ? 0x1000 : 0x8801000, bytes, false, avr ? 32 : 16);
                bridge = bridge(program);
                if (avr) {
                    DecompileOptions options = new DecompileOptions();
                    options.setMaxInstructions(Integer.MAX_VALUE);
                    options.setMaxWidth(40);
                    decompiler(bridge).setOptions(options);
                }
                DecompileResults result = observed(bridge, function, 8, avr ? "0x1008" : "0x8801008");
                if (avr) {
                    String pseudocode = result.getDecompiledFunction().getC();
                    require("avr_printed_word_coordinate", pseudocode.replaceAll("\\s+", " ").contains("jumptable at 0x0804."));
                    require("avr_warning_wraps", !pseudocode.contains("WARNING: Could not recover"));
                    require("avr_two_byte_addressable_unit", function.getEntryPoint().getAddressSpace().getAddressableUnitSize() == 2);
                } else {
                    require("mips_real_delay_slot", program.getListing().getInstructionAt(function.getEntryPoint().add(12)).isInDelaySlot());
                    require("mips_return_control", program.getListing().getInstructionAt(function.getEntryPoint().add(16)).getFlowType().isTerminal());
                }
            } finally {
                close(bridge);
                program.endTransaction(transaction, false);
                program.release(this);
            }
        }
    }

    @Override public void run() throws Exception {
        if (getScriptArgs().length != 1) throw new IllegalArgumentException("Pass the exact bridge source path");
        File expected = new File(getScriptArgs()[0]).getCanonicalFile();
        source = GhidraScriptUtil.findScriptByName("ReaGhidraBridge.java");
        if (source == null || !expected.equals(new File(source.getAbsolutePath()).getCanonicalFile()))
            throw new IllegalStateException("Bridge source resolution differs from the requested source");
        aarch64();
        otherArchitectures();
        JsonObject report = new JsonObject();
        report.addProperty("schema_version", 1);
        report.addProperty("status", "passed");
        report.addProperty("ghidra_version", Application.getApplicationVersion());
        report.addProperty("bridge_source_sha256", HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(expected.toPath()))));
        report.add("checks", checks);
        report.add("cases", cases);
        report.addProperty("scope", "real decompilations of synthetic ProgramDB instructions and detached markup controls; no target execution, transport, loader or additional processor admission claim");
        println("REA_INDIRECT_BRANCH_PROBE_JSON " + report);
        println("REA_INDIRECT_BRANCH_PROBE_COMPLETE");
    }
}
