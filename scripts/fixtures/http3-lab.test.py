"""Lifecycle regressions; these tests do not establish HTTP/3 provider support."""
import asyncio
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("http3_lab", Path(__file__).with_name("http3-lab.py"))
lab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lab)


class CleanupTests(unittest.IsolatedAsyncioTestCase):
    async def test_all_actions_run_after_multiple_close_failures(self):
        attempted = []
        async def fail():
            attempted.append("failed-close")
            raise RuntimeError("close failed")
        async def audit():
            attempted.append("audit")
        failures = await lab.attempt_all([("one", fail), ("two", fail), ("audit", audit)])
        self.assertEqual(attempted, ["failed-close", "failed-close", "audit"])
        self.assertEqual([name for name, _ in failures], ["one", "two"])

    def client_receipt(self, root, requested_case, response_case):
        journal = lab.Journal(root)
        headers = [(b":status", b"200"), (b"x-lab-case", response_case)]
        items = [lab.HeadersReceived(headers=headers, stream_id=4, stream_ended=False),
                 lab.DataReceived(data=lab.PARTIAL_BODY, stream_id=4, stream_ended=False)]
        client = SimpleNamespace(journal=journal, endpoint="client", identity="client-test",
                                 request_cases={4: requested_case}, messages={},
                                 http=SimpleNamespace(handle_event=Mock(return_value=items)))
        lab.Endpoint.quic_event_received(client, object())
        return journal, headers

    async def test_partial_receipt_uses_caller_selected_case_and_preserves_wrong_headers(self):
        with tempfile.TemporaryDirectory() as directory:
            journal, headers = self.client_receipt(Path(directory), "partial-before-reset", b"wrong-response-case")
            self.assertTrue(journal.partial_received.is_set())
            self.assertEqual([event["event"] for event in journal.events], ["response-headers", "response-progress"])
            self.assertEqual(journal.events[0]["headers"], lab.pairs(headers))
            self.assertEqual(journal.events[1]["body"], lab.binary(lab.PARTIAL_BODY))

    async def test_response_case_cannot_select_partial_receipt_for_another_request(self):
        with tempfile.TemporaryDirectory() as directory:
            journal, _ = self.client_receipt(Path(directory), "reset-recovery", b"partial-before-reset")
            self.assertFalse(journal.partial_received.is_set())
            self.assertEqual(journal.events, [])

    async def test_partial_reset_waits_for_client_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = lab.Journal(Path(directory))
            sent = asyncio.Event()
            class Endpoint:
                response_headers = lab.Endpoint.response_headers
            endpoint = Endpoint()
            endpoint.journal = journal
            endpoint.identity = "origin-test"
            endpoint.http = SimpleNamespace(send_headers=Mock(), send_data=Mock())
            endpoint.transmit = sent.set
            endpoint.reset_response = Mock()
            task = journal.task(lab.Endpoint.answer_partial(endpoint, "partial-before-reset", 4))
            try:
                await asyncio.wait_for(sent.wait(), 1)
                endpoint.http.send_data.assert_called_once_with(4, lab.PARTIAL_BODY, end_stream=False)
                endpoint.reset_response.assert_not_called()
                self.assertFalse(journal.responses["partial-before-reset"]["finished"])
                self.assertGreater(journal.responses["partial-before-reset"]["declared_body_bytes"], len(lab.PARTIAL_BODY))
                journal.partial_received.set()
                await asyncio.wait_for(task, 1)
                endpoint.reset_response.assert_called_once_with("partial-before-reset", 4)
            finally:
                await lab.finish_tasks(journal)

    async def test_cleanup_cancels_partial_response_waiting_for_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = lab.Journal(Path(directory))
            sent = asyncio.Event()
            class Endpoint:
                response_headers = lab.Endpoint.response_headers
            endpoint = Endpoint()
            endpoint.journal = journal
            endpoint.identity = "origin-test"
            endpoint.http = SimpleNamespace(send_headers=Mock(), send_data=Mock())
            endpoint.transmit = sent.set
            endpoint.reset_response = Mock()
            task = journal.task(lab.Endpoint.answer_partial(endpoint, "partial-before-reset", 4))
            try:
                await asyncio.wait_for(sent.wait(), 1)
            finally:
                await lab.finish_tasks(journal)
            self.assertTrue(task.cancelled())
            endpoint.reset_response.assert_not_called()

    async def test_partial_setup_keeps_primary_error_and_audits_after_close_failure(self):
        original_serve = lab.serve
        closed = []
        class ClosingServer:
            def __init__(self, server):
                self.server = server
            def close(self):
                self.server.close()
                closed.append(True)
                raise RuntimeError("injected close failure")
        async def serve(*args, **kwargs):
            return ClosingServer(await original_serve(*args, **kwargs))
        async def fail_tcp(*args, **kwargs):
            raise RuntimeError("injected primary setup failure")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "capture"
            with patch.object(lab, "serve", serve), patch.object(lab.asyncio, "start_server", fail_tcp):
                with self.assertRaisesRegex(RuntimeError, "injected primary setup failure") as caught:
                    await lab.run(SimpleNamespace(output=str(root), mitmdump="unused", with_origin_reset=False, with_partial_reset=False))
            self.assertEqual(closed, [True])
            self.assertIn("injected close failure", " ".join(caught.exception.__notes__))
            report = json.loads((root / "producer-cleanup.json").read_text())
            self.assertEqual(report["primary_error"], "injected primary setup failure")
            self.assertEqual(report["cleanup_errors"][0]["action"], "quic-server")
            self.assertEqual(report["groups"], [])
            self.assertFalse((root / "manifest.json").exists())


if __name__ == "__main__":
    unittest.main()
