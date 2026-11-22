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
 * into an output C file using DecompInterface. Writes a structured companion outcome
 * file (<output>.outcome.json) recording function counts and limit or error details.
 */
public class ReaDecompileToC extends GhidraScript {
    private static String escapeJson(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\b", "\\b")
                .replace("\f", "\\f")
                .replace("\n", "\\n")
                .replace("\r", "\\r")
                .replace("\t", "\\t");
    }

    private static void writeOutcome(File outcomeFile, String status, int decompiledCount, int failedCount,
            long bytesWritten, long maxOutputBytes, String error) {
        try {
            File parent = outcomeFile.getParentFile();
            if (parent != null && !parent.exists()) {
                parent.mkdirs();
            }
            try (BufferedWriter w = new BufferedWriter(
                    new OutputStreamWriter(new FileOutputStream(outcomeFile), StandardCharsets.UTF_8))) {
                w.write("{\n");
                w.write("  \"status\": \"" + status + "\",\n");
                w.write("  \"decompiled_functions\": " + decompiledCount + ",\n");
                w.write("  \"failed_functions\": " + failedCount + ",\n");
                w.write("  \"bytes_written\": " + bytesWritten + ",\n");
                w.write("  \"max_output_bytes\": " + maxOutputBytes);
                if (error != null) {
                    w.write(",\n  \"error\": \"" + escapeJson(error) + "\"\n");
                } else {
                    w.write("\n");
                }
                w.write("}\n");
            }
        } catch (Exception ignored) {
        }
    }

    private static long utf8ByteLength(CharSequence sequence, long limit) {
        long count = 0;
        int len = sequence.length();
        for (int i = 0; i < len; i++) {
            char ch = sequence.charAt(i);
            if (ch <= 0x7F) {
                count++;
            } else if (ch <= 0x7FF) {
                count += 2;
            } else if (Character.isHighSurrogate(ch)) {
                count += 4;
                i++;
            } else {
                count += 3;
            }
            if (count > limit) {
                return count;
            }
        }
        return count;
    }

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

        File target = new File(args[0]);
        File outputFile;
        if (target.isDirectory() || !args[0].toLowerCase().endsWith(".c")) {
            if (!target.exists()) {
                target.mkdirs();
            }
            outputFile = new File(target, currentProgram.getName() + ".c");
        } else {
            outputFile = target;
        }
        File outcomeFile = new File(outputFile.getAbsolutePath() + ".outcome.json");
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
                String openErr = "decompiler failed to open program: " + decompiler.getLastMessage();
                printerr("ReaDecompileToC: " + openErr);
                writeOutcome(outcomeFile, "failed", 0, 0, 0, maxOutputBytes, openErr);
                return;
            }

            long bytesWritten = 0;
            boolean limitExceeded = false;
            int decompiledCount = 0;
            int failedCount = 0;
            try (BufferedWriter writer = new BufferedWriter(
                    new OutputStreamWriter(new FileOutputStream(outputFile), StandardCharsets.UTF_8))) {
                String header = "/*\n * Decompiled with Ghidra (" + currentProgram.getName() + ")\n */\n\n";
                byte[] headerBytes = header.getBytes(StandardCharsets.UTF_8);
                bytesWritten += headerBytes.length;
                writer.write(header);

                FunctionIterator iter = currentProgram.getListing().getFunctions(true);
                while (iter.hasNext() && !monitor.isCancelled()) {
                    if (bytesWritten >= maxOutputBytes) {
                        limitExceeded = true;
                        break;
                    }
                    Function function = iter.next();
                    if (function.isExternal() || function.getBody().isEmpty()) {
                        continue;
                    }
                    long bodyNumAddresses = function.getBody().getNumAddresses();
                    String safeFunc = function.getName().replace("*/", "* /").replace("\r", " ").replace("\n", " ");
                    String safeEntry = String.valueOf(function.getEntryPoint()).replace("*/", "* /");
                    if (bodyNumAddresses > maxOutputBytes) {
                        failedCount++;
                        String warning = "/* WARNING: Function " + safeFunc + " at " + safeEntry + " body size (" + bodyNumAddresses + " addresses) exceeds output limit (" + maxOutputBytes + " bytes) */\n\n";
                        long remaining = maxOutputBytes - bytesWritten;
                        long warnBytes = utf8ByteLength(warning, remaining);
                        if (bytesWritten + warnBytes > maxOutputBytes) {
                            limitExceeded = true;
                            break;
                        }
                        writer.write(warning);
                        bytesWritten += warnBytes;
                        continue;
                    }
                    DecompileResults results = decompiler.decompileFunction(function, 30, monitor);
                    if (results != null && results.decompileCompleted()) {
                        DecompiledFunction decompFunc = results.getDecompiledFunction();
                        if (decompFunc != null) {
                            String cCode = decompFunc.getC();
                            if (cCode != null && !cCode.trim().isEmpty()) {
                                long remaining = maxOutputBytes - bytesWritten;
                                long cBytes = utf8ByteLength(cCode, remaining);
                                if (bytesWritten + cBytes + 2 > maxOutputBytes) {
                                    limitExceeded = true;
                                    break;
                                }
                                writer.write(cCode);
                                writer.write("\n\n");
                                bytesWritten += cBytes + 2;
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
                    String safeErr = errMsg.replace("*/", "* /").replace("\r", " ").replace("\n", " ");
                    String warning = "/* WARNING: Failed to decompile function " + safeFunc + " at " + safeEntry + ": " + safeErr + " */\n\n";
                    long remaining = maxOutputBytes - bytesWritten;
                    long warnBytes = utf8ByteLength(warning, remaining);
                    if (bytesWritten + warnBytes > maxOutputBytes) {
                        limitExceeded = true;
                        break;
                    }
                    writer.write(warning);
                    bytesWritten += warnBytes;
                }
                writer.flush();
                if (limitExceeded) {
                    writeOutcome(outcomeFile, "limit_exceeded", decompiledCount, failedCount, bytesWritten, maxOutputBytes,
                            "Decompiled C output exceeded " + maxOutputBytes + " byte limit");
                    if (decompiledCount > 0) {
                        println("ReaDecompileToC: limit exceeded; retained " + decompiledCount + " functions (" + bytesWritten + " bytes) to " + outputFile.getAbsolutePath());
                        return;
                    }
                    throw new RuntimeException("ReaDecompileToC: decompiled C output exceeded " + maxOutputBytes + " byte limit");
                }
                if (decompiledCount == 0) {
                    String noFuncErr = "No usable functions decompiled" + (failedCount > 0 ? " (" + failedCount + " failed)" : " (no non-empty functions found)");
                    writeOutcome(outcomeFile, "no_functions", 0, failedCount, bytesWritten, maxOutputBytes, noFuncErr);
                    throw new RuntimeException("ReaDecompileToC: " + noFuncErr);
                }
                writeOutcome(outcomeFile, "success", decompiledCount, failedCount, bytesWritten, maxOutputBytes, null);
                println("ReaDecompileToC: decompiled " + decompiledCount + " functions (" + failedCount + " failed/incomplete) to " + outputFile.getAbsolutePath());
            } catch (Exception writeEx) {
                printerr("ReaDecompileToC: failed writing decompiled output: " + writeEx.getMessage());
                if (decompiledCount == 0 && outputFile.exists()) {
                    outputFile.delete();
                }
                if (!outcomeFile.exists()) {
                    writeOutcome(outcomeFile, "failed", decompiledCount, failedCount, bytesWritten, maxOutputBytes, writeEx.getMessage());
                }
                throw writeEx;
            }
        } finally {
            decompiler.dispose();
        }
    }
}
