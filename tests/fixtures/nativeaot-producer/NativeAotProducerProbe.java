package rea.extensions.nativeaot;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import ghidra.program.model.listing.Program;
import ghidra.util.exception.CancelledException;
import ghidra.util.task.TaskMonitor;
import nativeaot.objectmodel.MethodTableManager;

/** Execute the actual producer against controlled APIs, not a real Ghidra runtime. */
public final class NativeAotProducerProbe {
    private static void require(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }
    private static JsonObject failure(boolean audit) throws Exception {
        MethodTableManager.failAudit = audit;
        MethodTableManager.failTypes = !audit;
        Program program = new Program();
        JsonObject report = new NativeAotExtension().analyze(program, new TaskMonitor());
        require(!program.committed && program.ends == 1, "failure must roll back exactly once");
        require(report.get("status").getAsString().equals("failed"), "expected failed status");
        require(report.get("method_tables").getAsInt() == 0, "rolled-back tables must not be reported");
        for (String key : new String[]{"types", "coverage", "derived_memory"})
            require(!report.has(key), "rolled-back report contains " + key);
        require(report.get("reason").getAsString().contains(audit ? "audit failure" : "type failure"), "failure reason lost");
        MethodTableManager.failAudit = MethodTableManager.failTypes = false;
        return report;
    }
    private static JsonObject success(boolean partial) throws Exception {
        Program.partial = partial;
        Program program = new Program();
        JsonObject report = new NativeAotExtension().analyze(program, new TaskMonitor());
        require(program.committed && program.ends == 1, "successful analysis must commit exactly once");
        require(report.get("status").getAsString().equals(partial ? "partial" : "complete"), "wrong coverage status");
        require(report.get("method_tables").getAsInt() == 1, "missing method table");
        for (String key : new String[]{"types", "coverage", "derived_memory"})
            require(report.has(key), "recovery missing " + key);
        Program.partial = false;
        return report;
    }
    public static void main(String[] args) throws Exception {
        if (args.length > 0 && !args[0].equals("--json")) {
            failure(args[0].equals("audit"));
            return;
        }
        JsonArray reports = new JsonArray();
        reports.add(failure(true));
        reports.add(failure(false));
        reports.add(success(false));
        reports.add(success(true));
        for (int cancelAt : new int[]{1, 4}) {
            Program program = new Program();
            TaskMonitor cancelled = new TaskMonitor();
            cancelled.cancelAt = cancelAt;
            try {
                new NativeAotExtension().analyze(program, cancelled);
                throw new AssertionError("expected cancellation");
            } catch (CancelledException expected) {
                require(!program.committed && program.ends == 1, "cancellation must roll back exactly once");
            }
        }
        System.out.println(args.length > 0 ? reports : "NativeAOT producer transaction contract passed (controlled API doubles)");
    }
}
