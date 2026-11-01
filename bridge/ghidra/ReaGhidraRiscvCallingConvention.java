import com.google.gson.JsonObject;
import ghidra.app.script.GhidraScript;
import ghidra.program.database.SpecExtension;
import ghidra.program.model.data.AbstractComplexDataType;
import ghidra.program.model.data.AbstractFloatDataType;
import ghidra.program.model.data.Array;
import ghidra.program.model.data.BitFieldDataType;
import ghidra.program.model.data.Composite;
import ghidra.program.model.data.DataType;
import ghidra.program.model.data.DataTypeComponent;
import ghidra.program.model.data.DoubleDataType;
import ghidra.program.model.data.Float16DataType;
import ghidra.program.model.data.FloatDataType;
import ghidra.program.model.data.FunctionDefinition;
import ghidra.program.model.data.IntegerDataType;
import ghidra.program.model.data.ParameterDefinition;
import ghidra.program.model.data.Pointer;
import ghidra.program.model.data.Structure;
import ghidra.program.model.data.StructureDataType;
import ghidra.program.model.data.TypeDef;
import ghidra.program.model.data.Union;
import ghidra.program.model.data.VoidDataType;
import ghidra.program.model.lang.CompilerSpec;
import ghidra.program.model.lang.Language;
import ghidra.program.model.lang.PrototypeModel;
import ghidra.program.model.lang.Register;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Parameter;
import ghidra.program.model.listing.Program;
import ghidra.program.model.listing.VariableStorage;
import ghidra.program.model.pcode.Varnode;
import ghidra.program.model.pcode.XmlEncode;
import java.io.StringReader;
import java.io.StringWriter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.transform.OutputKeys;
import javax.xml.transform.TransformerFactory;
import javax.xml.transform.dom.DOMSource;
import javax.xml.transform.stream.StreamResult;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;
import org.xml.sax.InputSource;

/**
 * Apply the committed RISC-V calling-convention policy after analysis. Ghidra's generic RV32
 * compiler specification models ilp32d. Each policy derives a program-specific prototype from the
 * program's own default prototype, as its {@link Policy} row and docs/ghidra-riscv.md state. The
 * script installs the prototype as a specification extension and assigns it, with dynamic
 * storage, to every non-thunk function, external function and function definition. A policy
 * whose prototype splits structures between register files also compares every signature with
 * the psABI and refuses an image whose signatures the prototype misplaces.
 */
public final class ReaGhidraRiscvCallingConvention extends GhidraScript {
  static final String REPORT_KEY = "REA RISC-V calling convention";
  /** RISC-V floating-point registers by ABI name: ft0-ft11, fs0-fs11 and fa0-fa7. */
  private static final Pattern FLOAT_REGISTER = Pattern.compile("f[ast]\\d+");
  /** The registers a policy that preserves floating-point registers keeps across calls. */
  private static final Pattern PRESERVED_FLOAT_REGISTER = Pattern.compile("fs\\d+");
  /** A refusal names this many signatures, each cut to this many characters. */
  private static final int REFUSAL_EXAMPLES = 8;
  private static final int REFUSAL_EXAMPLE_LENGTH = 160;

  /**
   * What a policy changes in the default ilp32d prototype. Every policy also passes values of 9
   * bytes or more, such as {@code long double}, by reference.
   *
   * @param floatEntryBytes the largest value a floating-point register may pass or return; 0
   *     removes those entries and every rule that assigns floating-point storage
   * @param preservesFloatRegisters whether fs0-fs11 stay preserved across calls
   * @param splitsStructures whether a structure of up to 8 bytes takes Ghidra's dual-class join,
   *     a float register for each 4-byte part that holds one float and an integer register for
   *     each other part; the script then refuses signatures that join misplaces
   */
  private record Policy(
      String id,
      String prototype,
      int floatEntryBytes,
      boolean preservesFloatRegisters,
      boolean splitsStructures) {}

  private static final List<Policy> POLICIES =
      List.of(
          new Policy("ilp32-prototype-v1", "__rea_ilp32", 0, false, false),
          new Policy("ilp32f-prototype-v1", "__rea_ilp32f", 4, true, true));

  /** Storage classes the psABI and a prototype can give a first argument or a return value. */
  private enum Kind {
    INTEGER,
    REFERENCE,
    FLOAT,
    FLOAT_PAIR,
    FLOAT_INTEGER,
    OTHER
  }

  private final Map<DataType, Kind> psabiKinds = new HashMap<>();
  private final Map<DataType, Kind> parameterKinds = new HashMap<>();
  private final Map<DataType, Kind> returnKinds = new HashMap<>();

  @Override
  public void run() throws Exception {
    String[] arguments = getScriptArgs();
    Policy policy =
        POLICIES.stream()
            .filter(candidate -> arguments.length == 1 && candidate.id().equals(arguments[0]))
            .findFirst()
            .orElseThrow(
                () ->
                    new IllegalArgumentException(
                        "REA RISC-V calling convention requires one of the policies "
                            + POLICIES.stream().map(Policy::id).toList()));
    Language language = currentProgram.getLanguage();
    if (!language.getProcessor().toString().equals("RISCV")
        || currentProgram.getDefaultPointerSize() != 4)
      throw new IllegalStateException(
          "REA " + policy.id() + " requires a 32-bit RISC-V program, not "
              + language.getLanguageID());
    CompilerSpec spec = currentProgram.getCompilerSpec();
    new SpecExtension(currentProgram)
        .addReplaceCompilerSpecExtension(
            derive(spec.getDefaultCallingConvention(), spec, language, policy), monitor);
    PrototypeModel model =
        currentProgram.getCompilerSpec().getCallingConvention(policy.prototype());
    if (model == null)
      throw new IllegalStateException("REA " + policy.prototype() + " was not installed");
    selfCheck(model, policy, language);
    int functions = 0;
    List<Function> callables = new ArrayList<>();
    currentProgram.getFunctionManager().getFunctions(true).forEach(callables::add);
    currentProgram.getFunctionManager().getExternalFunctions().forEach(callables::add);
    for (Function function : callables) {
      // A thunk's signature is its target's; the target is in this list.
      if (function.isThunk()) continue;
      if (function.hasCustomVariableStorage()) function.setCustomVariableStorage(false);
      function.setCallingConvention(policy.prototype());
      List<VariableStorage> storage = new ArrayList<>();
      storage.add(function.getReturn().getVariableStorage());
      for (Parameter parameter : function.getParameters())
        storage.add(parameter.getVariableStorage());
      // An untyped function has no assigned storage yet; the decompiler applies the
      // prototype when it recovers one.
      if (policy.floatEntryBytes() == 0)
        requireIntegerStorage(
            storage.toArray(VariableStorage[]::new), function.getName(true), true);
      else
        for (VariableStorage item : storage)
          if (item.isBadStorage())
            throw new IllegalStateException(
                "REA RISC-V storage unresolved for " + function.getName(true));
      functions += 1;
    }
    int definitions = 0;
    Set<FunctionDefinition> pointed = new HashSet<>();
    Iterator<DataType> types = currentProgram.getDataTypeManager().getAllDataTypes();
    while (types.hasNext()) {
      DataType type = types.next();
      // Definitions a pointer type refers to are the only ones an indirect call can use.
      if (type instanceof Pointer pointer
          && strip(pointer.getDataType()) instanceof FunctionDefinition target)
        pointed.add(target);
      if (!(type instanceof FunctionDefinition definition)) continue;
      definition.setCallingConvention(policy.prototype());
      definitions += 1;
    }
    if (policy.splitsStructures()) {
      String refusal = misplacedSignatures(model, policy, callables, pointed);
      if (refusal != null) {
        // Written instead of the outcome: REA refuses the session with this reason.
        JsonObject report = new JsonObject();
        report.addProperty("policy", policy.id());
        report.addProperty("refused", refusal);
        currentProgram.getOptions(Program.PROGRAM_INFO).setString(REPORT_KEY, report.toString());
        println("REA RISC-V " + policy.prototype() + " refused: " + refusal);
        return;
      }
    }
    // Written last: any failure above leaves no report, and REA refuses the session.
    currentProgram.getOptions(Program.PROGRAM_INFO).setString(
        REPORT_KEY,
        "{\"policy\":\"" + policy.id() + "\",\"functions\":" + functions
            + ",\"definitions\":" + definitions + "}");
    println(
        "REA RISC-V " + policy.prototype() + ": functions=" + functions
            + " definitions=" + definitions);
  }

  /** The default ilp32d prototype changed as the policy states. */
  private static String derive(
      PrototypeModel base, CompilerSpec spec, Language language, Policy policy) throws Exception {
    XmlEncode encoder = new XmlEncode();
    base.encode(encoder, spec.getPcodeInjectLibrary());
    DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
    factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
    Document document =
        factory.newDocumentBuilder().parse(new InputSource(new StringReader(encoder.toString())));
    Element root = document.getDocumentElement();
    if (!root.getTagName().equals("prototype"))
      throw new IllegalStateException("Unexpected default prototype encoding " + root.getTagName());
    root.setAttribute("name", policy.prototype());
    List<Element> floatEntries = new ArrayList<>();
    NodeList entries = root.getElementsByTagName("pentry");
    for (int index = 0; index < entries.getLength(); index += 1) {
      Element entry = (Element) entries.item(index);
      if (entry.getAttribute("storage").equals("float")) floatEntries.add(entry);
    }
    if (floatEntries.isEmpty())
      throw new IllegalStateException("Default prototype has no floating-point entries");
    Element input = list(root, "input");
    Element output = list(root, "output");
    if (policy.floatEntryBytes() == 0) {
      List<Node> removed = new ArrayList<>(floatEntries);
      NodeList rules = root.getElementsByTagName("rule");
      for (int index = 0; index < rules.getLength(); index += 1) {
        Element rule = (Element) rules.item(index);
        if (usesFloatStorage(rule)) removed.add(rule);
      }
      if (removed.size() == floatEntries.size())
        throw new IllegalStateException("Default prototype has no floating-point rules to remove");
      for (Node node : removed) node.getParentNode().removeChild(node);
    } else
      for (Element entry : floatEntries)
        entry.setAttribute("maxsize", Integer.toString(policy.floatEntryBytes()));
    // Values over 2 x XLEN go by reference. Returns need no rule: a value that the return
    // registers cannot hold already becomes a caller buffer passed in a0.
    input.insertBefore(rule(document, "any", "minsize", "9", "convert_to_ptr"), finalJoin(input));
    if (policy.splitsStructures())
      for (Element list : new Element[] {input, output}) {
        Element dual = rule(document, "struct", "maxsize", "8", "join_dual_class");
        ((Element) dual.getLastChild()).setAttribute("fillalternate", "true");
        list.insertBefore(dual, finalJoin(list));
      }
    if (!policy.preservesFloatRegisters()) {
      NodeList killedLists = root.getElementsByTagName("killedbycall");
      Element killed = killedLists.getLength() == 0 ? null : (Element) killedLists.item(0);
      if (killed == null) {
        killed = document.createElement("killedbycall");
        root.appendChild(killed);
      }
      List<Element> moved = new ArrayList<>();
      NodeList preservedLists = root.getElementsByTagName("unaffected");
      for (int list = 0; list < preservedLists.getLength(); list += 1) {
        NodeList preserved = preservedLists.item(list).getChildNodes();
        for (int index = 0; index < preserved.getLength(); index += 1) {
          if (preserved.item(index) instanceof Element varnode
              && isFloatRegister(varnode, language))
            moved.add(varnode);
        }
      }
      for (Element varnode : moved) {
        varnode.getParentNode().removeChild(varnode);
        killed.appendChild(varnode);
      }
    }
    StringWriter xml = new StringWriter();
    var transformer = TransformerFactory.newInstance().newTransformer();
    transformer.setOutputProperty(OutputKeys.OMIT_XML_DECLARATION, "yes");
    transformer.transform(new DOMSource(document), new StreamResult(xml));
    return xml.toString();
  }

  /** The installed prototype places each class of value as its policy states. */
  private void selfCheck(PrototypeModel model, Policy policy, Language language) {
    StructureDataType pair = new StructureDataType("rea_float_pair", 0);
    pair.add(FloatDataType.dataType);
    pair.add(FloatDataType.dataType);
    VariableStorage[] storage =
        model.getStorageLocations(
            currentProgram,
            new DataType[] {
              DoubleDataType.dataType, FloatDataType.dataType, DoubleDataType.dataType,
              IntegerDataType.dataType, pair, Float16DataType.dataType
            },
            false);
    VariableStorage quad = storage[storage.length - 1];
    if (quad.size() != currentProgram.getDefaultPointerSize() || quad.getRegister() == null)
      throw new IllegalStateException(
          "REA " + policy.prototype() + " does not pass a 16-byte value by reference: " + quad);
    if (policy.floatEntryBytes() == 0)
      requireIntegerStorage(storage, policy.prototype() + " self-check", false);
    if (policy.splitsStructures()) {
      StructureDataType tagged = new StructureDataType("rea_float_int", 0);
      tagged.add(FloatDataType.dataType);
      tagged.add(IntegerDataType.dataType);
      List<String> placed = new ArrayList<>();
      for (VariableStorage item :
          model.getStorageLocations(
              currentProgram,
              new DataType[] {
                tagged, FloatDataType.dataType, DoubleDataType.dataType, pair, tagged,
                IntegerDataType.dataType, FloatDataType.dataType
              },
              false))
        placed.add(item.toString());
      List<String> expected =
          List.of("a0:4,fa0:4", "fa0:4", "a1:4,a0:4", "fa2:4,fa1:4", "a2:4,fa3:4", "a3:4", "fa4:4");
      if (!placed.equals(expected))
        throw new IllegalStateException(
            "REA " + policy.prototype() + " self-check placed " + placed);
    }
    Set<String> preserved = new HashSet<>();
    for (Varnode varnode : model.getUnaffectedList()) {
      Register register = language.getRegister(varnode.getAddress(), varnode.getSize());
      if (register != null && FLOAT_REGISTER.matcher(register.getName()).matches()) {
        if (!policy.preservesFloatRegisters())
          throw new IllegalStateException(
              "REA " + policy.prototype() + " still preserves " + register.getName());
        if (PRESERVED_FLOAT_REGISTER.matcher(register.getName()).matches())
          preserved.add(register.getName());
      }
    }
    if (policy.preservesFloatRegisters() && preserved.size() != 12)
      throw new IllegalStateException(
          "REA " + policy.prototype() + " preserves only " + preserved);
  }

  /**
   * Name the signatures whose types the prototype misplaces, or null when there are none. Each
   * parameter and return type of every typed function and of every definition a pointer type
   * refers to is compared, as a first argument or a return, with the storage class the psABI
   * gives it after flattening.
   */
  private String misplacedSignatures(
      PrototypeModel model, Policy policy, List<Function> callables, Set<FunctionDefinition> pointed) {
    List<String> refused = new ArrayList<>();
    int functions = 0;
    for (Function function : callables) {
      if (function.isThunk()) continue;
      List<String> misplaced = new ArrayList<>();
      DataType returned = function.getReturn().getFormalDataType();
      if (misplaced(model, returned, true)) misplaced.add("returns " + returned.getName());
      for (Parameter parameter : function.getParameters())
        if (misplaced(model, parameter.getFormalDataType(), false))
          misplaced.add(parameter.getFormalDataType().getName());
      if (misplaced.isEmpty()) continue;
      functions += 1;
      refused.add(function.getName(true) + " (" + String.join(", ", misplaced) + ")");
    }
    int definitions = 0;
    for (FunctionDefinition definition : pointed) {
      List<String> misplaced = new ArrayList<>();
      if (misplaced(model, definition.getReturnType(), true))
        misplaced.add("returns " + definition.getReturnType().getName());
      for (ParameterDefinition argument : definition.getArguments())
        if (misplaced(model, argument.getDataType(), false))
          misplaced.add(argument.getDataType().getName());
      if (misplaced.isEmpty()) continue;
      definitions += 1;
      refused.add(
          "function-pointer type " + definition.getName() + " (" + String.join(", ", misplaced)
              + ")");
    }
    if (refused.isEmpty()) return null;
    List<String> examples = new ArrayList<>();
    for (String example : refused.subList(0, Math.min(REFUSAL_EXAMPLES, refused.size())))
      examples.add(
          example.length() <= REFUSAL_EXAMPLE_LENGTH
              ? example
              : example.substring(0, REFUSAL_EXAMPLE_LENGTH - 3) + "...");
    return counted(functions, "function") + " and " + counted(definitions, "function-pointer type")
        + " pass by-value types whose psABI storage " + policy.prototype() + " cannot express: "
        + String.join("; ", examples) + (refused.size() > examples.size() ? "; and others." : ".");
  }

  /** Whether the prototype gives a first argument or return of this type another class. */
  private boolean misplaced(PrototypeModel model, DataType type, boolean returned) {
    if (strip(type) instanceof VoidDataType || type.getLength() <= 0) return false;
    Kind psabi = psabiKinds.computeIfAbsent(type, ReaGhidraRiscvCallingConvention::psabiKind);
    Kind placed =
        (returned ? returnKinds : parameterKinds)
            .computeIfAbsent(type, value -> modelKind(model, value, returned));
    return psabi != placed;
  }

  /** The storage the prototype gives one value of this type as a first argument or return. */
  private Kind modelKind(PrototypeModel model, DataType type, boolean returned) {
    VariableStorage[] storage =
        model.getStorageLocations(
            currentProgram,
            returned ? new DataType[] {type} : new DataType[] {VoidDataType.dataType, type},
            false);
    VariableStorage item = storage[returned ? 0 : 1];
    if (item.isForcedIndirect()) return Kind.REFERENCE;
    int floats = 0;
    int others = 0;
    for (Varnode varnode : item.getVarnodes()) {
      Register register = currentProgram.getRegister(varnode);
      if (register != null && FLOAT_REGISTER.matcher(register.getName()).matches()) floats += 1;
      else others += 1;
    }
    if (floats == 0) return Kind.INTEGER;
    if (floats == 1 && others == 0) return Kind.FLOAT;
    if (floats == 2 && others == 0) return Kind.FLOAT_PAIR;
    if (floats == 1 && others == 1) return Kind.FLOAT_INTEGER;
    return Kind.OTHER;
  }

  /** The psABI's storage class for a first argument or return of this type, after flattening. */
  private static Kind psabiKind(DataType type) {
    List<Boolean> fields = new ArrayList<>();
    if (!(strip(type) instanceof Union) && flatten(type, fields)) {
      long floats = fields.stream().filter(Boolean::booleanValue).count();
      if (fields.size() == 1 && floats == 1) return Kind.FLOAT;
      if (fields.size() == 2 && floats == 2) return Kind.FLOAT_PAIR;
      if (fields.size() == 2 && floats == 1) return Kind.FLOAT_INTEGER;
    }
    return type.getLength() > 8 ? Kind.REFERENCE : Kind.INTEGER;
  }

  /**
   * Collect the psABI's flattened fields, true for a float of at most 32 bits. False when a
   * field makes the value use the integer convention: a union, a pointer, a value over 32 bits,
   * or a third field. Empty members, zero-length arrays and zero-width bit-fields are ignored.
   */
  private static boolean flatten(DataType type, List<Boolean> fields) {
    type = strip(type);
    if (type instanceof Structure structure) {
      for (DataTypeComponent component : structure.getDefinedComponents()) {
        if (component.getLength() == 0) continue;
        if (component.getDataType() instanceof BitFieldDataType bitField) {
          if (bitField.getBitSize() == 0) continue;
          if (bitField.getBaseDataType().getLength() > 4) return false;
          fields.add(false);
        } else if (!flatten(component.getDataType(), fields)) return false;
        if (fields.size() > 2) return false;
      }
      return true;
    }
    if (type instanceof Array array) {
      for (int index = 0; index < array.getNumElements(); index += 1)
        if (!flatten(array.getDataType(), fields) || fields.size() > 2) return false;
      return true;
    }
    if (type instanceof Union union) return union.getNumDefinedComponents() == 0;
    if (type instanceof AbstractComplexDataType) {
      if (type.getLength() > 8) return false;
      fields.add(true);
      fields.add(true);
      return true;
    }
    if (type instanceof AbstractFloatDataType) {
      if (type.getLength() > 4) return false;
      fields.add(true);
      return true;
    }
    if (type instanceof Pointer
        || type instanceof Composite
        || type instanceof FunctionDefinition
        || type.getLength() <= 0
        || type.getLength() > 4) return false;
    fields.add(false);
    return true;
  }

  private static DataType strip(DataType type) {
    while (type instanceof TypeDef typeDef) type = typeDef.getBaseDataType();
    return type;
  }

  private static String counted(int count, String noun) {
    return count + " " + noun + (count == 1 ? "" : "s");
  }

  private static Element list(Element root, String name) {
    NodeList lists = root.getElementsByTagName(name);
    if (lists.getLength() != 1)
      throw new IllegalStateException("Default prototype has no single " + name + " list");
    return (Element) lists.item(0);
  }

  /** The list's final rule, which joins any value into integer registers and the stack. */
  private static Element finalJoin(Element list) {
    Element last = null;
    for (Node child = list.getFirstChild(); child != null; child = child.getNextSibling())
      if (child instanceof Element element && element.getTagName().equals("rule")) last = element;
    if (last == null || !joinsAnyValue(last))
      throw new IllegalStateException(
          "Default prototype's " + list.getTagName() + " list does not end with a join");
    return last;
  }

  private static Element rule(
      Document document, String type, String bound, String size, String action) {
    Element rule = document.createElement("rule");
    Element datatype = document.createElement("datatype");
    datatype.setAttribute("name", type);
    datatype.setAttribute(bound, size);
    rule.appendChild(datatype);
    rule.appendChild(document.createElement(action));
    return rule;
  }

  private static boolean joinsAnyValue(Element rule) {
    List<Element> children = new ArrayList<>();
    for (Node child = rule.getFirstChild(); child != null; child = child.getNextSibling())
      if (child instanceof Element element) children.add(element);
    return children.size() == 2
        && children.get(0).getTagName().equals("datatype")
        && children.get(0).getAttribute("name").equals("any")
        && children.get(1).getTagName().equals("join");
  }

  /** Whether a rule's action, at any depth, assigns floating-point storage. */
  private static boolean usesFloatStorage(Element element) {
    NodeList children = element.getChildNodes();
    for (int index = 0; index < children.getLength(); index += 1) {
      if (!(children.item(index) instanceof Element child)) continue;
      if (child.getAttribute("storage").equals("float") || usesFloatStorage(child)) return true;
    }
    return false;
  }

  private static boolean isFloatRegister(Element varnode, Language language) {
    if (!varnode.getTagName().equals("varnode")
        || !varnode.getAttribute("space").equals("register"))
      return false;
    Register register =
        language.getRegister(
            language.getAddressFactory().getRegisterSpace()
                .getAddress(Long.decode(varnode.getAttribute("offset"))),
            Integer.parseInt(varnode.getAttribute("size")));
    return register != null && FLOAT_REGISTER.matcher(register.getName()).matches();
  }

  private static void requireIntegerStorage(
      VariableStorage[] storage, String owner, boolean allowUnassigned) {
    for (VariableStorage item : storage) {
      if (item.isBadStorage() || (!allowUnassigned && item.isUnassignedStorage()))
        throw new IllegalStateException("REA RISC-V storage unresolved for " + owner);
      List<Register> registers = item.getRegisters();
      if (registers == null) continue; // stack-only storage
      for (Register register : registers) {
        if (FLOAT_REGISTER.matcher(register.getName()).matches())
          throw new IllegalStateException(
              "REA RISC-V storage still uses " + register.getName() + " for " + owner);
      }
    }
  }
}
