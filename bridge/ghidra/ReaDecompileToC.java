import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileOptions;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.decompiler.DecompiledFunction;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
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
        long maxOutputBytes = 4L * 1024L * 1024L;
        if (args.length > 1) {
            try {
                maxOutputBytes = Long.parseLong(args[1]);
            } catch (NumberFormatException ignored) {
            }
        }
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

            long bytesWritten = 0;
            boolean limitExceeded = false;
            try (BufferedWriter writer = new BufferedWriter(
                    new OutputStreamWriter(new FileOutputStream(outputFile), StandardCharsets.UTF_8))) {
                String header = "/*\n * Decompiled with Ghidra (" + currentProgram.getName() + ")\n */\n\n";
                byte[] headerBytes = header.getBytes(StandardCharsets.UTF_8);
                bytesWritten += headerBytes.length;
                writer.write(header);

                FunctionIterator iter = currentProgram.getListing().getFunctions(true);
                int decompiledCount = 0;
                int failedCount = 0;
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
                                byte[] codeBytes = (cCode + "\n\n").getBytes(StandardCharsets.UTF_8);
                                if (bytesWritten + codeBytes.length > maxOutputBytes) {
                                    limitExceeded = true;
                                    break;
                                }
                                writer.write(cCode);
                                writer.write("\n\n");
                                bytesWritten += codeBytes.length;
                                decompiledCount++;
                                continue;
                            }
                        }
                    }
                    failedCount++;
                    String errMsg = (results != null) ? results.getErrorMessage() : "null results";
                    if (errMsg == null || errMsg.trim().isEmpty()) {
                        errMsg = "decompilation incomplete or timed out";
                    }
                    String safeFunc = function.getName().replace("*/", "* /").replace("\r", " ").replace("\n", " ");
                    String safeEntry = String.valueOf(function.getEntryPoint()).replace("*/", "* /");
                    String safeErr = errMsg.replace("*/", "* /").replace("\r", " ").replace("\n", " ");
                    String warning = "/* WARNING: Failed to decompile function " + safeFunc + " at " + safeEntry + ": " + safeErr + " */\n\n";
                    byte[] warnBytes = warning.getBytes(StandardCharsets.UTF_8);
                    if (bytesWritten + warnBytes.length > maxOutputBytes) {
                        limitExceeded = true;
                        break;
                    }
                    writer.write(warning);
                    bytesWritten += warnBytes.length;
                }
                writer.flush();
                if (limitExceeded) {
                    throw new RuntimeException("ReaDecompileToC: decompiled C output exceeded " + maxOutputBytes + " byte limit");
                }
                println("ReaDecompileToC: decompiled " + decompiledCount + " functions (" + failedCount + " failed/incomplete) to " + outputFile.getAbsolutePath());
                if (decompiledCount == 0 && failedCount > 0) {
                    throw new RuntimeException("ReaDecompileToC: all " + failedCount + " function(s) failed decompilation");
                }
            } catch (Exception writeEx) {
                printerr("ReaDecompileToC: failed writing decompiled output: " + writeEx.getMessage());
                if (outputFile.exists()) {
                    outputFile.delete();
                }
                throw writeEx;
            }
        } finally {
            decompiler.dispose();
        }
    }
}
