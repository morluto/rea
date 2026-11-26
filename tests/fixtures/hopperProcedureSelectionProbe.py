"""Exercise named-entry and explicit-coordinate selection at the Hopper boundary."""
import json
from pathlib import Path
import sys

bridge_path = sys.argv[1]
bridge = {"__file__": bridge_path, "__name__": "rea_hopper_bridge"}
exec(compile(Path(bridge_path).read_text(encoding="utf-8"), bridge_path, "exec"), bridge)

class Procedure:
    def getEntryPoint(self):
        return 0x401000
    def getSegment(self):
        return segment
class Segment:
    def getNameAtAddress(self, address):
        if address == 0x40B000:
            return "CloseHandle"
        return "entry" if address == 0x401000 else "inner"
    def getReferencesOfAddress(self, address):
        # Two call sites inside the procedure (one repeated), a data reference
        # outside it, and Hopper's invalid-address sentinel.
        return [0x40C000, 0x401010, 0x401010, 0x401020, 0xFFFFFFFFFFFFFFFF] if address == 0x40B000 else []
    def getProcedureAtAddress(self, address):
        # 0x40b000 models an import address-table slot outside every procedure.
        return procedure if 0x401000 <= address < 0x402000 else None
class Document:
    def __init__(self):
        self.names = []
        self.cursor = 0x401004
    def getCurrentAddress(self):
        return self.cursor
    def getAddressForName(self, name):
        self.names.append(name)
        return {
            "entry": 0x401000,
            "alias_entry": 0x401000,
            "inner": 0x401004,
            "CloseHandle": 0x40B000,
        }.get(name)
    def getSegmentAtAddress(self, address):
        return segment
segment = Segment()
procedure = Procedure()
document = Document()
results = {}
def select(key, selector):
    try:
        selected = bridge["_procedure"](document, selector)
        results[key] = {"entry": bridge["_hex"](selected.getEntryPoint())}
    except Exception as error:
        results[key] = {
            "diagnostic_type": bridge["_diagnostic_type"](error),
            "message": str(error),
            "diagnostic": bridge["_safe_diagnostic"](error),
        }
for selector in [
    "entry",
    "alias_entry",
    "inner",
    "0x401004",
    "401004",
    "file-offset:0x4",
    "CloseHandle",
    "0x40b000",
    "missing_fn",
]:
    select(selector, selector)
# Incoming references answer an explicit address outside every procedure;
# a name outside every procedure still fails, for REA's selector owner.
incoming = {}
for selector in ["0x40b000", "CloseHandle"]:
    for key, method in [("references", "_procedure_references"), ("callers", "_caller_base")]:
        try:
            incoming["%s %s" % (key, selector)] = bridge[method](
                document, {"procedure": selector, "direction": "incoming"}
            )
        except Exception as error:
            incoming["%s %s" % (key, selector)] = {"diagnostic": bridge["_safe_diagnostic"](error)}
# An omitted selector reads the cursor, here parked outside every procedure.
document.cursor = 0x40B000
select("<cursor>", None)
print(json.dumps({"results": results, "incoming": incoming, "name_lookups": document.names}))
