//@category REA Verification

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import generic.jar.ResourceFile;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.script.GhidraScript;
import ghidra.app.script.GhidraScriptUtil;
import ghidra.framework.Application;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.CommentType;
import ghidra.program.model.listing.Function;
import ghidra.program.model.symbol.Symbol;
import java.io.File;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.HexFormat;

/**
 * Adds caller-authored entry plate comments that spell Ghidra's removed-block warning
 * to decompiler-removed-block.S in a real analysis database. Ghidra renders such a
 * comment with the same header renderer as decompiler warnings; it must not become
 * a removed-block record. Never executes target code.
 */
public class ReaDecompilerWarningProvenanceProbe extends GhidraScript {
    private static final String WARNING = "WARNING: Removing unreachable block (";
    private final JsonArray checks = new JsonArray();
    private final JsonObject report = new JsonObject();
    private GhidraScript bridge;
    private Method analyze;
    private Method canonical;

    private void require(String name, boolean condition, Object detail) {
        if (!condition)
            throw new IllegalStateException("Warning provenance assertion failed: " + name + ": " + detail);
        checks.add(name);
    }

    // Mach-O objects can keep the C symbol as a secondary label at the entry.
    private Function function(String name) {
        for (String spelling : new String[] { name, "_" + name })
            for (Symbol symbol : currentProgram.getSymbolTable().getSymbols(spelling)) {
                Function f = currentProgram.getFunctionManager().getFunctionAt(symbol.getAddress());
                if (f != null && !f.isThunk()) return f;
            }
        throw new IllegalStateException("Missing fixture function " + name);
    }

    private GhidraScript script(String name, File expected) throws Exception {
        ResourceFile source = GhidraScriptUtil.findScriptByName(name);
        if (source == null || !expected.equals(new File(source.getAbsolutePath()).getCanonicalFile()))
            throw new IllegalStateException("Fixture resolved an unexpected script: " + name);
        GhidraScript instance = GhidraScriptUtil.getProvider(source).getScriptInstance(source, errorWriter);
        instance.set(getState(), getControls());
        return instance;
    }

    private JsonObject dossier(Function function) throws Exception {
        JsonObject query = new JsonObject();
        query.addProperty("procedure", canonical(function.getEntryPoint()));
        Object observation = analyze.invoke(bridge, query);
        Method accessor = observation.getClass().getDeclaredMethod("dossier");
        accessor.setAccessible(true);
        return (JsonObject) accessor.invoke(observation);
    }

    private String canonical(Address address) throws Exception {
        return (String) canonical.invoke(bridge, address);
    }

    private static JsonObject completeness(JsonObject dossier) {
        return dossier.getAsJsonObject("decompiler_completeness");
    }

    private static int occurrences(String text, String line) {
        int count = 0;
        for (int index = text.indexOf(line); index >= 0; index = text.indexOf(line, index + 1)) count++;
        return count;
    }

    private static boolean commentRetained(JsonObject dossier, String text) {
        for (JsonElement comment : dossier.getAsJsonArray("comments"))
            if (comment.getAsJsonObject().get("text").getAsString().equals(text)) return true;
        return false;
    }

    private static boolean namesDroppedBlocks(JsonObject dossier) {
        for (JsonElement limitation : dossier.getAsJsonArray("limitations"))
            if (limitation.getAsString().contains("decompiler_completeness.dropped_blocks")) return true;
        return false;
    }

    private static JsonArray dropped(JsonObject dossier) {
        return completeness(dossier).getAsJsonArray("dropped_blocks");
    }

    private static int warningCount(JsonObject dossier) {
        return completeness(dossier).get("warning_count").getAsInt();
    }

    private void setPlate(Function function, String text) {
        currentProgram.getListing().setComment(function.getEntryPoint(), CommentType.PLATE, text);
    }

    private void setPre(Address address, String text) {
        currentProgram.getListing().setComment(address, CommentType.PRE, text);
    }

    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length != 1) throw new IllegalArgumentException("Expected exact bridge directory");
        File directory = new File(args[0]).getCanonicalFile();
        bridge = script("ReaGhidraBridge.java", new File(directory, "ReaGhidraBridge.java"));
        Field space = bridge.getClass().getDeclaredField("sessionDefaultAddressSpace");
        space.setAccessible(true);
        space.set(null, currentProgram.getAddressFactory().getDefaultAddressSpace());
        Method initialize = bridge.getClass().getDeclaredMethod("initializeDecompiler");
        initialize.setAccessible(true);
        initialize.invoke(bridge);
        analyze = bridge.getClass().getDeclaredMethod("analyzeFunctionObservation", JsonObject.class);
        analyze.setAccessible(true);
        canonical = bridge.getClass().getDeclaredMethod("canonicalAddress", Address.class);
        canonical.setAccessible(true);
        Field decompiler = bridge.getClass().getDeclaredField("decompiler");
        decompiler.setAccessible(true);

        Function removed = function("rea_removed_block");
        Function reachable = function("rea_reachable_block");
        String removedStart = canonical(removed.getEntryPoint().add(0x10));
        try {
            JsonObject baseline = dossier(removed);
            JsonArray baselineBlocks = dropped(baseline);
            JsonObject baselineBlock = baselineBlocks.size() == 1 ? baselineBlocks.get(0).getAsJsonObject() : null;
            require("baseline_real_removal", baselineBlock != null &&
                baselineBlock.get("start").getAsString().equals(removedStart) &&
                baselineBlock.get("end").isJsonNull() &&
                baselineBlock.has("listing_block"),
                completeness(baseline));
            int baselineWarnings = warningCount(baseline);
            String pseudocode = baseline.get("pseudocode").getAsString();
            int at = pseudocode.indexOf(WARNING);
            require("baseline_warning_rendered", at >= 0, pseudocode);
            String realWarning = pseudocode.substring(at, pseudocode.indexOf(" */", at));
            JsonObject control = dossier(reachable);
            int controlWarnings = warningCount(control);
            require("control_no_dropped_blocks", dropped(control).size() == 0, completeness(control));

            // A plate naming a real in-body block start of a function with no removal.
            Address inBody = reachable.getEntryPoint().add(0xc);
            require("decoy_target_in_body", reachable.getBody().contains(inBody), canonical(inBody));
            String decoy = WARNING + inBody.getAddressSpace().getName() + ",0x" +
                Long.toHexString(inBody.getOffset()) + ")";
            setPlate(reachable, decoy);
            JsonObject decoyed = dossier(reachable);
            require("plate_decoy_rendered_as_header",
                decoyed.get("pseudocode").getAsString().contains("/* " + decoy + " */"),
                decoyed.get("pseudocode"));
            require("plate_decoy_not_recorded",
                dropped(decoyed).size() == 0 && warningCount(decoyed) == controlWarnings,
                completeness(decoyed));
            require("plate_decoy_no_omission_limitation", !namesDroppedBlocks(decoyed),
                decoyed.get("limitations"));
            require("plate_decoy_comment_retained", commentRetained(decoyed, decoy),
                decoyed.get("comments"));

            // A plate naming a space Ghidra does not have is not a decompiler warning either.
            String unmappedDecoy = WARNING + "rea_no_such_space,0x10)";
            setPlate(reachable, unmappedDecoy);
            JsonObject unmapped = dossier(reachable);
            require("plate_unmapped_decoy_not_recorded",
                dropped(unmapped).size() == 0 && warningCount(unmapped) == controlWarnings,
                completeness(unmapped));
            setPlate(reachable, null);

            // An analyst's body comment spelling a warning stays in the pseudocode and is not recorded.
            Address bodyComment = reachable.getEntryPoint().add(0x4);
            setPre(bodyComment, decoy);
            JsonObject preDecoyed = dossier(reachable);
            require("body_comment_decoy_not_recorded",
                dropped(preDecoyed).size() == 0 && warningCount(preDecoyed) == controlWarnings,
                completeness(preDecoyed));
            require("body_comment_decoy_retained", commentRetained(preDecoyed, decoy),
                preDecoyed.get("comments"));
            report.addProperty("body_comment_rendered_in_pseudocode",
                preDecoyed.get("pseudocode").getAsString().contains(decoy));
            setPre(bodyComment, null);

            // A plate repeating the decompiler's own warning: both render, one is decompiler-owned.
            setPlate(removed, realWarning);
            JsonObject repeated = dossier(removed);
            require("repeated_warning_rendered_twice",
                occurrences(repeated.get("pseudocode").getAsString(), "/* " + realWarning + " */") == 2,
                repeated.get("pseudocode"));
            JsonArray repeatedBlocks = dropped(repeated);
            require("repeated_warning_keeps_real_removal", repeatedBlocks.size() == 1 &&
                repeatedBlocks.get(0).getAsJsonObject().get("start").getAsString().equals(removedStart) &&
                warningCount(repeated) == baselineWarnings,
                completeness(repeated));
            setPlate(removed, null);
        } finally {
            ((DecompInterface) decompiler.get(bridge)).dispose();
        }

        report.addProperty("status", "passed");
        report.addProperty("ghidra_version", Application.getApplicationVersion());
        report.addProperty("target_sha256", currentProgram.getExecutableSHA256());
        report.addProperty("removed_start", removedStart);
        byte[] bytes = Files.readAllBytes(new File(directory, "ReaGhidraBridge.java").toPath());
        report.addProperty("ReaGhidraBridge.java",
            HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)));
        report.add("checks", checks);
        println("REA_WARNING_PROVENANCE_PROBE_JSON " + report);
    }
}
