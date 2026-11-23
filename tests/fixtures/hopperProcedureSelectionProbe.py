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
        return "entry" if address == 0x401000 else "inner"
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
# An omitted selector reads the cursor, here parked outside every procedure.
document.cursor = 0x40B000
select("<cursor>", None)
print(json.dumps({"results": results, "name_lookups": document.names}))
