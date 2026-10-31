//@category REA Verification

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import ghidra.app.plugin.core.analysis.DWARFAnalyzer;
import ghidra.app.script.GhidraScript;
import ghidra.app.script.GhidraScriptUtil;
import ghidra.program.model.listing.Function;
import ghidra.program.model.symbol.Symbol;
import java.io.File;
import java.lang.reflect.Method;

/** Real ELF loader import; checks the production bridge's entry label fact. */
public class ReaElfRoleLabelProbe extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        require(args.length == 3 || (args.length == 4 && args[3].equals("dwarf-imported")),
            "Expected the production bridge directory, entry address, label and optional dwarf-imported");
        var source = GhidraScriptUtil.findScriptByName("ReaGhidraBridge.java");
        require(source != null && new File(source.getAbsolutePath()).getCanonicalFile().equals(
            new File(args[0], "ReaGhidraBridge.java").getCanonicalFile()), "Production bridge source");
        GhidraScript bridge = GhidraScriptUtil.getProvider(source).getScriptInstance(source, errorWriter);
        require(currentProgram.getExecutableFormat().equals("Executable and Linking Format (ELF)"),
            "ELF loader import");
        // Pins the reason for a DWARF fixture's label to Ghidra's own import record.
        require(DWARFAnalyzer.isAlreadyImported(currentProgram) == (args.length == 4),
            "DWARF import state");
        Function function = getFunctionAt(toAddr(Long.decode(args[1])));
        require(function != null && function.getName(true).equals("entry"), "Function at the ELF header entry");
        Method metadata = bridge.getClass().getDeclaredMethod("symbolMetadata", Symbol.class);
        metadata.setAccessible(true);
        JsonObject facts = (JsonObject) metadata.invoke(null, function.getSymbol());
        require(facts.get("source").getAsString().equals("imported"), "Ghidra imported source " + facts);
        JsonElement label = facts.get("loader_role_label");
        require(label != null && label.getAsString().equals(args[2]), "Loader role label " + facts);
        println("REA_ELF_ROLE_LABEL_OK " + args[2]);
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new IllegalStateException(message);
    }
}
