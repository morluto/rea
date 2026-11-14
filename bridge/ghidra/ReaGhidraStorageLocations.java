import ghidra.program.model.data.DataType;
import ghidra.program.model.lang.PrototypeModel;
import ghidra.program.model.listing.Program;
import ghidra.program.model.listing.VariableStorage;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;

/**
 * Calls {@link PrototypeModel#getStorageLocations(Program, DataType[], boolean, boolean)} on
 * Ghidra builds that have it, and the three-argument form on builds that do not.
 *
 * <p>Ghidra 12.2 added a fourth {@code isVarArgs} parameter and deprecated the three-argument
 * overload, which now delegates with {@code isVarArgs = false}. REA's accepted floor is 12.1,
 * where only the three-argument form exists, so a direct call to either overload fails to
 * compile against one of the two lines: the four-argument signature is absent from 12.1.x
 * jars, and the three-argument one is deprecated (removal-scheduled) on 12.2. Resolving the
 * method once at class initialisation keeps a single packaged source compiling and behaving
 * identically on every accepted release.
 *
 * <p>Both forms pass {@code isVarArgs = false}, so the storage computed here is the same on
 * every accepted release; this helper changes how the method is reached, not what it returns.
 */
final class ReaGhidraStorageLocations {

  private static final boolean HAS_VARARGS_OVERLOAD = findVarArgsOverload() != null;

  private ReaGhidraStorageLocations() {}

  /**
   * Storage for {@code types} using the prototype model's non-varargs rules.
   *
   * @param model the calling convention whose rules place the values
   * @param program the program supplying the data organization
   * @param types the argument types, in order
   * @param useForcedIndirect whether the model's forced-indirect rules apply
   */
  static VariableStorage[] of(
      PrototypeModel model, Program program, DataType[] types, boolean useForcedIndirect) {
    return HAS_VARARGS_OVERLOAD
        ? invokeVarArgsOverload(model, program, types, useForcedIndirect)
        : model.getStorageLocations(program, types, useForcedIndirect);
  }

  /** Whether the running release has the four-argument form (Ghidra 12.2 and later). */
  static boolean hasVarArgsOverload() {
    return HAS_VARARGS_OVERLOAD;
  }

  private static Method findVarArgsOverload() {
    try {
      return PrototypeModel.class.getMethod(
          "getStorageLocations", Program.class, DataType[].class, boolean.class, boolean.class);
    } catch (NoSuchMethodException absentBeforeGhidra12_2) {
      return null;
    }
  }

  private static VariableStorage[] invokeVarArgsOverload(
      PrototypeModel model, Program program, DataType[] types, boolean useForcedIndirect) {
    try {
      return (VariableStorage[])
          findVarArgsOverload().invoke(model, program, types, useForcedIndirect, false);
    } catch (IllegalAccessException | InvocationTargetException unreachable) {
      // The method exists and is public, and the three-argument form with the same arguments
      // does not throw, so reflection cannot be the call that fails here.
      Throwable cause =
          unreachable instanceof InvocationTargetException invocation
                  && invocation.getCause() != null
              ? invocation.getCause()
              : unreachable;
      throw new IllegalStateException(
          "REA could not call PrototypeModel.getStorageLocations: " + unreachable, cause);
    }
  }
}
