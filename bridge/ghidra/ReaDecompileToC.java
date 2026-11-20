import ghidra.app.script.GhidraScript;
import ghidra.app.util.exporter.CppExporter;
import java.io.File;

/**
 * Headless Ghidra script that exports decompiled C pseudocode for the current program
 * into an output C file using CppExporter.
 */
public class ReaDecompileToC extends GhidraScript {
    @Override
    public void run() throws Exception {
        if (currentProgram == null) {
            printerr("ReaDecompileToC: no program loaded");
            return;
        }

        String[] args = getScriptArgs();
        if (args.length == 0) {
            printerr("ReaDecompileToC: missing output file path argument");
            return;
        }

        File outputFile = new File(args[0]);
        File parent = outputFile.getParentFile();
        if (parent != null && !parent.exists()) {
            parent.mkdirs();
        }

        CppExporter exporter = new CppExporter();
        exporter.export(outputFile, currentProgram, null, monitor);
        println("ReaDecompileToC: exported decompiled C to " + outputFile.getAbsolutePath());
    }
}
