"""Source-owned tests for the mitmproxy adapter's record projection."""

import base64
import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest
from unittest import mock


def load_capture(resource_module=None):
    """Load the adapter with fresh mitmproxy stand-ins scoped to its import."""
    fake_mitmproxy = types.ModuleType("mitmproxy")
    fake_mitmproxy.ctx = types.SimpleNamespace()
    fake_mitmproxy.version = types.SimpleNamespace(VERSION="12.3.1")
    fake_io = types.ModuleType("mitmproxy.io")
    fake_io.tnetstring = types.ModuleType("mitmproxy.io.tnetstring")
    if resource_module is None:
        try:
            import resource as resource_module
        except ImportError:
            resource_module = types.ModuleType("resource")
            resource_module.RLIM_INFINITY = -1
            resource_module.RLIMIT_AS = 9
            resource_module.RLIMIT_CPU = 0
            resource_module.RLIMIT_CORE = 4
            resource_module.RLIMIT_FSIZE = 1
            resource_module.getrlimit = lambda kind: (resource_module.RLIM_INFINITY, resource_module.RLIM_INFINITY)
            resource_module.setrlimit = lambda kind, limits: None
    stand_ins = {
        "mitmproxy": fake_mitmproxy,
        "mitmproxy.io": fake_io,
        "mitmproxy.io.tnetstring": fake_io.tnetstring,
        "resource": resource_module,
    }
    spec = importlib.util.spec_from_file_location(
        "rea_mitmproxy_capture", os.path.join(os.path.dirname(__file__), "capture.py")
    )
    module = importlib.util.module_from_spec(spec)
    with mock.patch.dict(sys.modules, stand_ins):
        spec.loader.exec_module(module)
    return module


capture = load_capture()


def location(value, scheme=None):
    state = {"response": {"headers": [[b"Location", value]]}}
    if scheme is not None:
        state["request"] = {"scheme": scheme}
    record = capture.project_record(state, [], 64)
    sidecar = next(
        field for field in record["binary_fields"] if field["pointer"] == "/response/headers/0/1"
    )
    return record["reported"]["response"]["headers"][0][1], sidecar, record["redactions"]


class TransportUserinfoTests(unittest.TestCase):
    def assert_location_redacted(self, value, expected, scheme=None):
        text, sidecar, redactions = location(value, scheme)
        self.assertEqual(text, expected)
        self.assertEqual(sidecar, {
            "pointer": "/response/headers/0/1",
            "representation": "producer-bytes",
            "state": "redacted",
            "content_base64": None,
            "bytes": None,
            "sha256": None,
        })
        self.assertEqual(
            redactions,
            [{"pointer": "/response/headers/0/1", "reason": "transport-credential"}],
        )

    def assert_location_retained(self, value, scheme=None):
        text, sidecar, redactions = location(value, scheme)
        self.assertEqual(text, value.decode("utf-8"))
        self.assertEqual(sidecar["state"], "retained")
        self.assertEqual(base64.b64decode(sidecar["content_base64"]), value)
        self.assertEqual(redactions, [])

    def test_ignorable_controls_cannot_hide_authority_credentials(self):
        for control in [b"\t", b"\n", b"\r"]:
            for value in [b"https://" + control + b"/user:pass@host/path", b"ht" + control + b"tps://user:" + control + b"pass@host/path"]:
                with self.subTest(value=value):
                    text, sidecar, redactions = location(value, b"https")
                    self.assertNotIn("user", text)
                    self.assertNotIn("pass", text)
                    self.assertEqual(sidecar["state"], "redacted")
                    self.assertEqual(len(redactions), 1)

    def test_mixed_network_separators_remove_credentials(self):
        for prefix in [b"\\\\", b"/\\", b"\\/"]:
            with self.subTest(prefix=prefix):
                self.assert_location_redacted(
                    prefix + b"user:pass@host/path", prefix.decode("ascii") + "host/path", b"https"
                )

    def test_non_special_base_keeps_backslashes_inside_network_authorities(self):
        text, sidecar, redactions = location(b"//user\\name:pass@host/x", b"foo")
        self.assertEqual(text, "//host/x")
        self.assertEqual(sidecar["state"], "redacted")
        self.assertEqual(len(redactions), 1)
        text, sidecar, redactions = location(b"/\\invoice@customer", b"foo")
        self.assertEqual(text, "/\\invoice@customer")
        self.assertEqual(sidecar["state"], "retained")
        self.assertEqual(redactions, [])

    def test_native_request_paths_preserve_origin_form_and_redact_absolute_form(self):
        for value in [b"/\\invoice@customer", b"//invoice@customer", b"\\\\invoice@customer"]:
            with self.subTest(value=value):
                record = capture.project_record({"request": {"path": value}}, [], 64)
                self.assertEqual(record["reported"]["request"]["path"], value.decode("ascii"))
                self.assertEqual(record["binary_fields"][0]["state"], "retained")
                self.assertEqual(record["redactions"], [])
        record = capture.project_record({"request": {"path": b"https://user:pass@host/x"}}, [], 64)
        self.assertEqual(record["reported"]["request"]["path"], "https://host/x")
        self.assertEqual(record["binary_fields"][0]["state"], "redacted")

    def test_same_scheme_locations_preserve_relative_path_text_and_bytes(self):
        for value in [b"https:invoice@customer", b"https:/invoice@customer", b"https:\\invoice@customer"]:
            with self.subTest(value=value):
                self.assert_location_retained(value, b"https")

    def test_location_authorities_still_remove_credentials_with_a_base_scheme(self):
        for value, scheme, expected in [
            (b"https://user:pass@host/path", b"https", "https://host/path"),
            (b"https:\\\\user:pass@host/path", b"https", "https:\\\\host/path"),
            (b"https:user:pass@host/path", b"http", "https:host/path"),
        ]:
            with self.subTest(value=value, scheme=scheme):
                self.assert_location_redacted(value, expected, scheme)

    def test_backup_location_uses_its_own_request_scheme(self):
        record = capture.project_record({
            "request": {"scheme": b"http"},
            "backup": {
                "request": {"scheme": b"https"},
                "response": {"headers": [[b"Location", b"https:invoice@customer"]]},
            },
        }, [], 64)
        self.assertEqual(record["reported"]["backup"]["response"]["headers"][0][1], "https:invoice@customer")
        self.assertEqual(record["redactions"], [])

    def test_where_a_special_scheme_authority_ends(self):
        self.assert_location_retained(b"https://example.test\\part@tail")
        self.assert_location_redacted(
            b"https://user:pw@example.test\\path", "https://example.test\\path"
        )
        self.assert_location_redacted(
            b"https://user:pw@example.test/a@b", "https://example.test/a@b"
        )

    def test_empty_userinfo_marker_is_removed(self):
        self.assertEqual(
            capture.without_userinfo("https://@host"), "https://host"
        )

    def test_special_schemes_skip_leading_slashes_before_userinfo(self):
        for value, expected in [
            (b"https://\\user:pass@host/path", b"https://\\host/path"),
            (b"https:\\\\user:pass@host/path", b"https:\\\\host/path"),
            (b"https:user:pass@host", b"https:host"),
            (b"//\\user:pass@host", b"//\\host"),
        ]:
            with self.subTest(value=value):
                self.assertEqual(capture.without_userinfo(value), expected)
        text, sidecar, redactions = location(b"https://\\user:pass@host/path")
        self.assertEqual(text, "https://\\host/path")
        self.assertEqual(sidecar["state"], "redacted")
        self.assertEqual(len(redactions), 1)

    def test_file_base_keeps_paths_after_the_fixed_network_boundary(self):
        for value in [b"///u@h", b"////u@h"]:
            with self.subTest(value=value):
                self.assert_location_retained(value, b"file")

    def test_file_urls_keep_path_text(self):
        self.assertEqual(capture.without_userinfo("file:///a@b"), "file:///a@b")

    def test_file_urls_reject_userinfo_and_keep_their_source(self):
        # WHATWG rejects an "@" in a file host, so nothing parses as credentials.
        self.assertEqual(
            capture.without_userinfo("file://user:pass@host/x"), "file://user:pass@host/x"
        )
        for value in [b"\\\\user:pass@host/x", b"/\\user:pass@host/x", b"//user:pass@host/x"]:
            with self.subTest(value=value):
                self.assert_location_retained(value, b"file")

    def test_rejected_special_hosts_keep_their_source(self):
        # A rejected host or port fails the whole URL, so it has no userinfo.
        for value in [
            "https:user@%",
            "https://user@",
            "https://user:pass@h^st/x",
            "https://user@ho st/x",
            "https://user@host:99999/x",
            "https://user@host:12a",
            "https://user@[::1",
        ]:
            with self.subTest(value=value):
                self.assertEqual(capture.without_userinfo(value), value)
        self.assert_location_retained(b"https://user:pass@h^st/x", b"https")

    def test_accepted_special_hosts_still_remove_userinfo(self):
        for value, expected in [
            ("https:user@%41", "https:%41"),
            ("https://user@[::1]:8443/x", "https://[::1]:8443/x"),
            ("https://user@host:/x", "https://host:/x"),
            ("wss://user:pass@host:65535", "wss://host:65535"),
            ("https://user@0x7f.1/", "https://0x7f.1/"),
            ("https://user@1.2.3.4./", "https://1.2.3.4./"),
            ("https://user@4294967295/", "https://4294967295/"),
            ("https://user@1.2.3.08a/", "https://1.2.3.08a/"),
            ("https://user@[::ffff:1.2.3.4]/", "https://[::ffff:1.2.3.4]/"),
        ]:
            with self.subTest(value=value):
                self.assertEqual(capture.without_userinfo(value), expected)

    def test_unicode_hosts_that_may_map_to_accepted_hosts_remove_userinfo(self):
        # UTS #46 maps these to 1.2.3.4; mapping is not modeled, so redact.
        for host in ["%EF%BC%91.2.3.4", "1。2.3.4", "%C2%AD1.2.3.4", "１.2.3.4"]:
            with self.subTest(host=host):
                self.assertEqual(
                    capture.without_userinfo(f"https://user:pw@{host}/"), f"https://{host}/"
                )
        self.assert_location_redacted(
            b"https://user:pw@%EF%BC%91.2.3.4/", "https://%EF%BC%91.2.3.4/", b"https"
        )
        # ASCII rejections still hold for non-ASCII hosts.
        self.assertEqual(capture.without_userinfo("https://user@１^/"), "https://user@１^/")

    def test_trailing_controls_and_spaces_do_not_hide_userinfo(self):
        # WHATWG strips trailing C0 controls and spaces before parsing.
        for suffix in [b" ", b"\x01", b"\x00 \x1f"]:
            with self.subTest(suffix=suffix):
                value = b"https://user:pw@example.test" + suffix
                self.assert_location_redacted(
                    value, "https://example.test" + suffix.decode("latin-1"), b"https"
                )

    def test_rejected_ip_literals_keep_their_source(self):
        for value in [
            "https://user:pass@256.256.256.256/path",
            "https://user@1.2.3.4.5/",
            "https://user@1.2.3.09/",
            "https://user@4294967296/",
            "https://user@a.0x/",
            "https://user@1..2/",
            "https://user@1." + "9" * 5000 + "/",
            "https://user@[1::2::3]/",
            "https://user@[::1%25eth0]/",
        ]:
            with self.subTest(value=value[:40]):
                self.assertEqual(capture.without_userinfo(value), value)

    def test_overlong_ports_are_compared_without_numeric_overflow(self):
        # Python 3.11+ refuses int() on decimal strings over 4300 digits.
        accepted = "https://user@host:" + "0" * 5000 + "80/x"
        self.assertEqual(capture.without_userinfo(accepted), "https://host:" + "0" * 5000 + "80/x")
        rejected = "https://user@host:" + "9" * 5000 + "/x"
        self.assertEqual(capture.without_userinfo(rejected), rejected)

    def test_non_special_schemes_keep_backslashes_in_the_authority(self):
        self.assertEqual(capture.without_userinfo("foo://a\\b@host/x"), "foo://host/x")
        self.assertEqual(capture.without_userinfo(b"//a\\b@host"), b"//a\\b@host")


class ProfileGateTests(unittest.TestCase):
    def test_profile_matches_verified_mitmproxy_release(self):
        self.assertEqual(capture.PROFILE, "12.3.1")

    def test_decode_rejects_a_different_runtime_version(self):
        with mock.patch.object(capture.version, "VERSION", "12.2.3"):
            with self.assertRaises(capture.CaptureFailure) as raised:
                capture.decode({"snapshot_path": "/tmp/unused.mitm", "sensitive_values": []})
        self.assertEqual(raised.exception.reason, "unsupported")
        self.assertIn("12.3.1", str(raised.exception))
        self.assertIn("12.2.3", str(raised.exception))


class OfflineLimitTests(unittest.TestCase):
    def load_limited(self, limits, setrlimit):
        resource = types.ModuleType("resource")
        resource.RLIM_INFINITY = 2 ** 62
        resource.RLIMIT_AS = 1
        resource.RLIMIT_CPU = 2
        resource.RLIMIT_CORE = 3
        resource.RLIMIT_FSIZE = 4
        resource.getrlimit = lambda kind: limits[kind]
        resource.setrlimit = setrlimit
        return load_capture(resource)

    def test_tighter_hard_limits_are_kept_and_shutdown_still_runs(self):
        infinity = 2 ** 62
        # Linux never reports a soft limit above its hard limit. Start at that ceiling.
        limits = {
            1: (1024, 1024),
            2: (5, 5),
            3: (infinity, infinity),
            4: (512, 512),
        }
        calls = []

        def setrlimit(kind, pair):
            _soft, hard = limits[kind]
            if hard != infinity and pair[1] > hard:
                raise ValueError("not allowed to raise maximum limit")
            calls.append((kind, pair))
            limits[kind] = pair

        module = self.load_limited(limits, setrlimit)
        shutdowns = []
        module.ctx.master = types.SimpleNamespace(shutdown=lambda: shutdowns.append("down"))
        with tempfile.TemporaryDirectory() as parent:
            request_path = os.path.join(parent, "request.json")
            reply_path = os.path.join(parent, "reply.json")
            with open(request_path, "w", encoding="utf-8") as handle:
                json.dump(
                    {
                        "budgets": {"inputBytes": 8, "outputBytes": 1000, "depth": 2},
                        "reply_path": reply_path,
                    },
                    handle,
                )
            module.ctx.options = types.SimpleNamespace(rea_request_path=request_path)
            module.addons[0].running()
            with open(reply_path, encoding="ascii") as handle:
                reply = json.loads(handle.read())
        self.assertEqual(
            calls,
            [(1, (1024, 1024)), (2, (5, 5)), (3, (0, 0)), (4, (512, 512))],
        )
        self.assertEqual(shutdowns, ["down"])
        self.assertFalse(reply["ok"])

    def test_inherited_hard_limit_stays_above_the_new_soft_limit(self):
        infinity = 2 ** 62
        address_limit = 768 * 1024 * 1024
        output_bytes = 1000
        # Unlimited CPU, and finite soft limits strictly below their hard limits.
        # Writing the new soft value into the hard limit fails these pairs.
        limits = {
            1: (address_limit * 2, address_limit * 4),
            2: (infinity, infinity),
            3: (infinity, infinity),
            4: (5000, 9000),
        }
        calls = []

        def setrlimit(kind, pair):
            _soft, hard = limits[kind]
            if hard != infinity and pair[1] > hard:
                raise ValueError("not allowed to raise maximum limit")
            calls.append((kind, pair))
            limits[kind] = pair

        module = self.load_limited(limits, setrlimit)
        shutdowns = []
        module.ctx.master = types.SimpleNamespace(shutdown=lambda: shutdowns.append("down"))
        with tempfile.TemporaryDirectory() as parent:
            request_path = os.path.join(parent, "request.json")
            reply_path = os.path.join(parent, "reply.json")
            with open(request_path, "w", encoding="utf-8") as handle:
                json.dump(
                    {
                        "budgets": {"inputBytes": 8, "outputBytes": output_bytes, "depth": 2},
                        "reply_path": reply_path,
                    },
                    handle,
                )
            module.ctx.options = types.SimpleNamespace(rea_request_path=request_path)
            module.addons[0].running()
            with open(os.path.join(parent, "effective-cpu.json"), encoding="ascii") as handle:
                cpu_record = json.load(handle)
        self.assertEqual(cpu_record, {"requested_seconds": 30, "seconds": 30})
        self.assertEqual(
            calls,
            [
                (1, (address_limit, address_limit * 4)),
                (2, (30, infinity)),
                (3, (0, 0)),
                (4, (output_bytes, 9000)),
            ],
        )
        self.assertEqual(shutdowns, ["down"])

    def test_tighter_inherited_cpu_limit_is_recorded(self):
        infinity = 2 ** 62
        limits = {kind: (infinity, infinity) for kind in (1, 3, 4)}
        limits[2] = (1, 100)
        calls = []

        def setrlimit(kind, pair):
            _soft, hard = limits[kind]
            if hard != infinity and pair[1] > hard:
                raise ValueError("not allowed to raise maximum limit")
            calls.append((kind, pair))
            limits[kind] = pair

        module = self.load_limited(limits, setrlimit)
        shutdowns = []
        module.ctx.master = types.SimpleNamespace(shutdown=lambda: shutdowns.append("down"))
        with tempfile.TemporaryDirectory() as parent:
            request_path = os.path.join(parent, "request.json")
            reply_path = os.path.join(parent, "reply.json")
            with open(request_path, "w", encoding="utf-8") as handle:
                json.dump(
                    {
                        "budgets": {"inputBytes": 8, "outputBytes": 1000, "depth": 2},
                        "reply_path": reply_path,
                    },
                    handle,
                )
            module.ctx.options = types.SimpleNamespace(rea_request_path=request_path)
            module.addons[0].running()
            with open(os.path.join(parent, "effective-cpu.json"), encoding="ascii") as handle:
                cpu_record = json.load(handle)
        self.assertEqual(calls[1], (2, (1, 100)))
        self.assertEqual(cpu_record, {"requested_seconds": 30, "seconds": 1})
        self.assertFalse(os.path.exists(os.path.join(parent, "effective-cpu.json.tmp")))
        self.assertEqual(shutdowns, ["down"])

    def test_tighter_inherited_file_limit_bounds_the_reply(self):
        infinity = 2 ** 62
        file_limit = 4096
        limits = {kind: (infinity, infinity) for kind in (1, 2, 3)}
        limits[4] = (file_limit, 8192)
        calls = []

        def setrlimit(kind, pair):
            _soft, hard = limits[kind]
            if hard != infinity and pair[1] > hard:
                raise ValueError("not allowed to raise maximum limit")
            calls.append((kind, pair))
            limits[kind] = pair

        module = self.load_limited(limits, setrlimit)
        module.decode = lambda _request: {"pad": "x" * 5000}
        shutdowns = []
        module.ctx.master = types.SimpleNamespace(shutdown=lambda: shutdowns.append("down"))
        with tempfile.TemporaryDirectory() as parent:
            request_path = os.path.join(parent, "request.json")
            reply_path = os.path.join(parent, "reply.json")
            with open(request_path, "w", encoding="utf-8") as handle:
                json.dump(
                    {
                        "budgets": {"inputBytes": 8, "outputBytes": 10000, "depth": 2},
                        "reply_path": reply_path,
                    },
                    handle,
                )
            module.ctx.options = types.SimpleNamespace(rea_request_path=request_path)
            module.addons[0].running()
            with open(reply_path, "rb") as handle:
                reply_bytes = handle.read()
        reply = json.loads(reply_bytes.decode("ascii"))
        self.assertLessEqual(len(reply_bytes), file_limit)
        self.assertEqual(reply["reason"], "fixed-limit")
        self.assertEqual(reply["boundary"], "file-size")
        self.assertEqual(reply["ceiling"]["limit"], file_limit)
        self.assertEqual(calls[-1], (4, (file_limit, 8192)))
        self.assertEqual(shutdowns, ["down"])

    def _memory_failure(self, address_soft, address_hard):
        infinity = 2 ** 62
        limits = {kind: (infinity, infinity) for kind in (2, 3, 4)}
        limits[1] = (address_soft, address_hard)
        calls = []

        def setrlimit(kind, pair):
            _soft, hard = limits[kind]
            if hard != infinity and pair[1] > hard:
                raise ValueError("not allowed to raise maximum limit")
            calls.append((kind, pair))
            limits[kind] = pair

        module = self.load_limited(limits, setrlimit)

        def exhausted(_request):
            raise MemoryError("payload must not enter diagnostics")

        module.decode = exhausted
        shutdowns = []
        module.ctx.master = types.SimpleNamespace(shutdown=lambda: shutdowns.append("down"))
        with tempfile.TemporaryDirectory() as parent:
            request_path = os.path.join(parent, "request.json")
            reply_path = os.path.join(parent, "reply.json")
            with open(request_path, "w", encoding="utf-8") as handle:
                json.dump(
                    {
                        "budgets": {"inputBytes": 8, "outputBytes": 10000, "depth": 2},
                        "reply_path": reply_path,
                    },
                    handle,
                )
            module.ctx.options = types.SimpleNamespace(rea_request_path=request_path)
            module.addons[0].running()
            with open(reply_path, "rb") as handle:
                reply_bytes = handle.read()
        return json.loads(reply_bytes.decode("ascii")), reply_bytes, calls, shutdowns, module

    def test_tighter_inherited_address_limit_names_the_memory_ceiling(self):
        soft = 512 * 1024 * 1024
        hard = 1024 * 1024 * 1024
        reply, reply_bytes, calls, shutdowns, _module = self._memory_failure(soft, hard)
        self.assertNotIn(b"payload must not enter diagnostics", reply_bytes)
        self.assertEqual(reply["reason"], "fixed-limit")
        self.assertEqual(reply["boundary"], "memory")
        self.assertEqual(reply["ceiling"]["limit"], soft)
        self.assertEqual(reply["ceiling"]["kind"], "bytes")
        self.assertIn(str(soft), reply["message"])
        self.assertNotIn("exhausted its 768 MiB", reply["message"])
        self.assertEqual(calls[0], (1, (soft, hard)))
        self.assertEqual(shutdowns, ["down"])

    def test_requested_address_budget_stays_a_resource_limit(self):
        budget = 768 * 1024 * 1024
        reply, reply_bytes, calls, shutdowns, module = self._memory_failure(budget * 2, budget * 4)
        self.assertNotIn(b"payload must not enter diagnostics", reply_bytes)
        self.assertEqual(reply["reason"], "resource-limit")
        self.assertEqual(reply["message"], "Native decoder exhausted its 768 MiB address-space budget.")
        self.assertNotIn("ceiling", reply)
        self.assertEqual(calls[0], (1, (budget, budget * 4)))
        self.assertEqual(shutdowns, ["down"])
        direct = module.failure_reply(MemoryError("payload must not enter diagnostics"))
        self.assertEqual(direct["reason"], "resource-limit")
        self.assertNotIn("payload must not enter diagnostics", json.dumps(direct))

    def test_limit_setup_failure_still_shuts_down(self):
        infinity = 2 ** 62
        limits = {kind: (infinity, infinity) for kind in (1, 2, 3, 4)}

        def setrlimit(_kind, _pair):
            raise ValueError("not allowed to raise maximum limit")

        module = self.load_limited(limits, setrlimit)
        shutdowns = []
        module.ctx.master = types.SimpleNamespace(shutdown=lambda: shutdowns.append("down"))
        module.ctx.options = types.SimpleNamespace(rea_request_path="")
        with self.assertRaisesRegex(ValueError, "not allowed to raise maximum limit"):
            module.addons[0].running()
        self.assertEqual(shutdowns, ["down"])


if __name__ == "__main__":
    unittest.main()
