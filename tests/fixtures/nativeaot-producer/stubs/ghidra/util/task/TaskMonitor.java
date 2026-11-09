package ghidra.util.task;
import ghidra.util.exception.CancelledException;
public class TaskMonitor {
public int cancelAt, checks;
public void checkCancelled() throws CancelledException {
    checks++;
if(checks == cancelAt) throw new CancelledException();
}
}
