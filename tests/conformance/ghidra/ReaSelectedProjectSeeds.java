import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSet;
import ghidra.program.model.listing.Function;
import ghidra.program.model.symbol.SourceType;
import ghidra.program.model.symbol.Symbol;
import java.util.List;

// Create addressable entries without decoding their instructions or analyzing calls.
public class ReaSelectedProjectSeeds extends GhidraScript {
    @Override public void run() throws Exception {
        for (String name : List.of("rea_project_leaf", "rea_project_caller", "rea_project_other")) {
            List<Symbol> symbols = getSymbols(name, null);
            if (symbols.isEmpty()) symbols = getSymbols("_" + name, null);
            if (symbols.size() != 1) throw new IllegalStateException("Expected one symbol for " + name);
            Address entry = symbols.get(0).getAddress();
            Function function = getFunctionAt(entry);
            if (function == null)
                function = currentProgram.getFunctionManager().createFunction(
                    symbols.get(0).getName(), entry, new AddressSet(entry, entry), SourceType.USER_DEFINED);
            if (currentProgram.getListing().getInstructions(function.getBody(), true).hasNext())
                throw new IllegalStateException("Expected an unanalyzed function: " + name);
            println("REA_PROJECT_SEED " + name + " " + entry);
        }
    }
}
