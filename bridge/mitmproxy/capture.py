"""REA offline adapter using mitmproxy's unchanged native tnetstring decoder.

No FlowReader migrations, HAR conversion, proxy listener, or target requests.
The containing mitmdump process and its configuration directory are REA-owned.
"""

import base64
import hashlib
import json
import math
import re
import resource
from pathlib import Path

from mitmproxy import ctx, version
from mitmproxy.io import tnetstring

PROFILE = "12.2.3"
OUTPUT_BYTES = 96 * 1024 * 1024
CREDENTIALS = {b"authorization", b"proxy-authorization", b"cookie", b"set-cookie"}


class CaptureFailure(Exception):
    def __init__(self, reason, message, pointer=""):
        self.reason, self.pointer = reason, pointer
        super().__init__(message)


def pointer(parent, key):
    return parent + "/" + str(key).replace("~", "~0").replace("/", "~1")


class BoundedReader:
    """Refuse malicious declared lengths before the upstream parser allocates."""
    def __init__(self, handle, size):
        self.handle, self.size = handle, size

    def read(self, count):
        if count < 0 or count > self.size - self.handle.tell():
            raise CaptureFailure("format", "Native record declares bytes beyond the retained capture.")
        return self.handle.read(count)


def project_record(state, secrets):
    binaries, numbers, redactions = [], [], []
    byte_secrets = []
    for secret in secrets:
        try:
            byte_secrets.append(secret.encode("utf-8", errors="strict"))
        except UnicodeEncodeError:
            # Non-scalar JSON strings have no UTF-8 byte representation.
            # Keep them in secrets for the ordinary string projection.
            pass

    def redact(text, path, original):
        if any(secret in text or secret in original for secret in secrets):
            redactions.append({"pointer": path, "reason": "explicit-sensitive-value"})
            return None
        return text

    def transport_value(value, path, transport_url):
        if not (transport_url or re.fullmatch(r"/(?:backup/)*request/(?:path|authority)", path)):
            return value, False
        binary = isinstance(value, bytes)
        pattern = rb"^([\x00-\x20]*(?:[a-z][a-z0-9+.-]*:)?//)[^/?#]*@" if binary else r"^([\x00-\x20]*(?:[a-z][a-z0-9+.-]*:)?//)[^/?#]*@"
        replacement = rb"\1" if binary else r"\1"
        separator = b"@" if binary else "@"
        safe_url = re.sub(pattern, replacement, value, flags=re.I)
        if path.endswith("/authority") and separator in safe_url:
            safe_url = safe_url.rsplit(separator, 1)[1]
        changed = safe_url != value
        if changed:
            redactions.append({"pointer": path, "reason": "transport-credential"})
        return safe_url, changed

    def validate_omitted(value, path, depth):
        before = len(binaries), len(numbers), len(redactions)
        visit(value, path, depth)
        del binaries[before[0]:]
        del numbers[before[1]:]
        del redactions[before[2]:]

    def visit(value, path, depth=0, credential=False, transport_url=False):
        if depth > 64:
            raise CaptureFailure("input-limit", "Native capture exceeds the 64-level evidence nesting budget.", path)
        if credential:
            validate_omitted(value, path, depth)
            redactions.append({"pointer": path, "reason": "transport-credential"})
            if isinstance(value, bytes):
                binaries.append({"pointer": path, "representation": "producer-bytes", "state": "redacted", "content_base64": None, "bytes": None, "sha256": None})
            return None
        if isinstance(value, bytes):
            safe_bytes, credential_url = transport_value(value, path, transport_url)
            content_base64 = base64.b64encode(value).decode("ascii")
            digest = hashlib.sha256(value).hexdigest()
            hidden = any(secret in value or secret in safe_bytes for secret in byte_secrets) or any(secret in content_base64 or secret in digest for secret in secrets)
            safe_text = None
            try:
                safe_text = safe_bytes.decode("utf-8", errors="strict")
            except UnicodeDecodeError:
                pass
            if hidden:
                redactions.append({"pointer": path, "reason": "explicit-sensitive-value"})
            exclude = hidden or credential_url
            binaries.append({"pointer": path, "representation": "producer-bytes", "state": "redacted" if exclude else "retained", "content_base64": None if exclude else content_base64, "bytes": None if exclude else len(value), "sha256": None if exclude else digest})
            if hidden:
                return None
            return safe_text
        if isinstance(value, str):
            safe_text, _ = transport_value(value, path, transport_url)
            return redact(safe_text, path, value)
        if isinstance(value, bool) or value is None:
            return value
        if isinstance(value, (int, float)):
            literal = repr(value)
            if any(secret in literal for secret in secrets):
                redactions.append({"pointer": path, "reason": "explicit-sensitive-value"})
                return None
            numbers.append({"pointer": path, "producer_type": "integer" if isinstance(value, int) else "float", "literal": literal})
            return value if (abs(value) <= 9007199254740991 if isinstance(value, int) else math.isfinite(value)) else None
        if isinstance(value, (list, tuple)):
            fields = re.fullmatch(r"/(?:backup/)*(?:request|response)/(?:headers|trailers)", path)
            if fields:
                result = []
                for index, field in enumerate(value):
                    if not isinstance(field, (list, tuple)) or len(field) != 2 or not isinstance(field[0], bytes):
                        raise CaptureFailure("format", "Native header/trailer is not an ordered byte pair.", pointer(path, index))
                    result.append([visit(field[0], pointer(pointer(path, index), 0), depth + 2), visit(field[1], pointer(pointer(path, index), 1), depth + 2, field[0].lower() in CREDENTIALS, field[0].lower() in {b"location", b"referer", b"origin"})])
                return result
            return [visit(item, pointer(path, index), depth + 1) for index, item in enumerate(value)]
        if isinstance(value, dict):
            result = {}
            for key, item in value.items():
                if not isinstance(key, str):
                    raise CaptureFailure("format", "Native record has a non-string dictionary key.", path)
                if key == "__proto__":
                    raise CaptureFailure("unsupported", "Native object contains a __proto__ member that the current JSON schema boundary cannot preserve.", path)
                if any(secret in key for secret in secrets):
                    # Validate the omitted subtree too, then discard all of its
                    # coordinates rather than inventing a replacement identity.
                    validate_omitted(item, pointer(path, key), depth + 1)
                    redactions.append({"pointer": path, "reason": "explicit-sensitive-value", "scope": "property-name"})
                    continue
                result[key] = visit(item, pointer(path, key), depth + 1)
            return result
        raise CaptureFailure("decoder", "Native parser returned an unexpected value type: " + type(value).__name__ + ".", path)

    return {"reported": visit(state, ""), "binary_fields": binaries, "numeric_literals": numbers, "redactions": redactions}


def decode(request):
    if version.VERSION != PROFILE:
        raise CaptureFailure("unsupported", "Expected mitmproxy " + PROFILE + "; observed " + version.VERSION + ".")
    records = []
    capture = Path(request["snapshot_path"])
    size = capture.stat().st_size
    with capture.open("rb") as handle:
        reader = BoundedReader(handle, size)
        while handle.tell() < size:
            start = handle.tell()
            try:
                state = tnetstring.load(reader)
            except CaptureFailure:
                raise
            except RecursionError:
                raise CaptureFailure("input-limit", "Native parser exceeded its recursion budget at byte offset " + str(start) + ".") from None
            except (ValueError, IndexError, UnicodeError, EOFError):
                raise CaptureFailure("format", "Malformed native record at byte offset " + str(start) + ".") from None
            if not isinstance(state, dict):
                raise CaptureFailure("format", "Native flow record must be a dictionary at byte offset " + str(start) + ".")
            records.append({"ordinal": len(records), "location": {"kind": "byte-range", "offset": start, "bytes": handle.tell() - start}, **project_record(state, request["sensitive_values"]), "limitations": ["Fields are original native states without FlowReader migration. Binary fields contain exact producer bytes; reported UTF-8 strings for those fields are derived display views. Unknown flow/version extensions are retained without interpretation."]})
    return {"decoder": {"id": "mitmproxy-native-tnetstring", "name": "REA offline native mitmproxy adapter", "version": PROFILE}, "container": {"reported": None, "numeric_literals": [], "redactions": [], "records_pointer": None}, "total_records": len(records), "records": records}


def failure_reply(error):
    """Keep producer constraints, resource exhaustion and adapter defects distinct."""
    if isinstance(error, CaptureFailure):
        return {"ok": False, "reason": error.reason, "message": str(error), "pointer": error.pointer}
    if isinstance(error, MemoryError):
        return {"ok": False, "reason": "resource-limit", "message": "Native decoder exhausted its 768 MiB address-space budget.", "pointer": ""}
    return {"ok": False, "reason": "decoder", "message": "Offline native decoder failed unexpectedly: " + type(error).__name__ + ".", "pointer": ""}


class OfflineCapture:
    def load(self, loader):
        loader.add_option("rea_request_path", str, "", "REA private offline capture request")

    def running(self):
        resource.setrlimit(resource.RLIMIT_AS, (768 * 1024 * 1024, 768 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
        resource.setrlimit(resource.RLIMIT_FSIZE, (OUTPUT_BYTES, OUTPUT_BYTES))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        request = json.loads(Path(ctx.options.rea_request_path).read_text(encoding="utf-8"))
        try:
            response = {"ok": True, "value": decode(request)}
        except Exception as error:
            response = failure_reply(error)
        try:
            try:
                output = json.dumps(response, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("ascii")
            except Exception as error:
                output = json.dumps(failure_reply(error), separators=(",", ":")).encode("ascii")
            if len(output) > OUTPUT_BYTES:
                output = b'{"ok":false,"reason":"limit","message":"Native reply exceeds the complete-evidence output budget.","pointer":""}'
            Path(request["reply_path"]).write_bytes(output)
        finally:
            ctx.master.shutdown()


addons = [OfflineCapture()]
