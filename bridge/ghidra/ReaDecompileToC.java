import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileOptions;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.decompiler.DecompiledFunction;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;

/**
 * Headless Ghidra script that exports decompiled C pseudocode for the current program
 * into an output C file using DecompInterface.
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

        DecompInterface decompiler = new DecompInterface();
        try {
            DecompileOptions options = new DecompileOptions();
            decompiler.setOptions(options);
            decompiler.toggleCCode(true);
            decompiler.toggleSyntaxTree(true);
            decompiler.toggleJumpLoads(true);
            if (!decompiler.openProgram(currentProgram)) {
                printerr("ReaDecompileToC: decompiler failed to open program: " + decompiler.getLastMessage());
                return;
            }

            try (PrintWriter writer = new PrintWriter(
                    new OutputStreamWriter(new FileOutputStream(outputFile), StandardCharsets.UTF_8))) {
                writer.println("/*");
                writer.println(" * Decompiled with Ghidra (" + currentProgram.getName() + ")");
                writer.println(" */");
                writer.println();

                FunctionIterator iter = currentProgram.getListing().getFunctions(true);
                int decompiledCount = 0;
                while (iter.hasNext() && !monitor.isCancelled()) {
                    Function function = iter.next();
                    if (function.isExternal() || function.getBody().isEmpty()) {
                        continue;
                    }
                    DecompileResults results = decompiler.decompileFunction(function, 30, monitor);
                    if (results != null && results.decompileCompleted()) {
                        DecompiledFunction decompFunc = results.getDecompiledFunction();
                        if (decompFunc != null) {
                            String cCode = decompFunc.getC();
                            if (cCode != null && !cCode.trim().isEmpty()) {
                                writer.println(cCode);
                                writer.println();
                                decompiledCount++;
                            }
                        }
                    }
                }
                println("ReaDecompileToC: decompiled " + decompiledCount + " functions to " + outputFile.getAbsolutePath());
            }
        } finally {
            decompiler.dispose();
        }
    }
}
