"""Project selected verifier facts without importing or running agentenv."""

import unittest
from types import SimpleNamespace

from bridge.agentenv.solve import _solve_facts


def run_with(verifications, outcome="passed"):
    return SimpleNamespace(context={"metadata": {"verifications": verifications}},
                           outcome=SimpleNamespace(value=outcome))


class SolveFactsTest(unittest.TestCase):
    def test_matching_verifier_success_and_failure(self):
        for passed, score, outcome in ((True, 1.0, "passed"), (False, 0.0, "scored below 1")):
            with self.subTest(passed=passed):
                run = run_with({"wanted": {"results": [{"id": "selected", "result": passed}],
                                           "score": score}})
                self.assertEqual(_solve_facts(run, "wanted"),
                                 (outcome, [{"id": "selected", "passed": passed, "description": ""}]))

    def test_missing_empty_and_unscored_selected_verifier_do_not_borrow_success(self):
        other = {"results": [{"id": "unrelated", "result": True}], "score": 1.0}
        for selected in (None, {}, {"results": [], "score": 1.0},
                         {"results": [{"id": 0, "result": False}]}):
            for reversed_order in (False, True):
                with self.subTest(selected=selected, reversed_order=reversed_order):
                    entries = [("other", other)]
                    if selected is not None:
                        entries.append(("wanted", selected))
                    if reversed_order:
                        entries.reverse()
                    expected = ([{"id": "0", "passed": False, "description": ""}]
                                if selected and selected.get("results") else [])
                    self.assertEqual(_solve_facts(run_with(dict(entries)), "wanted"),
                                     ("unscored", expected))

    def test_selected_score_owns_outcome_and_checks_preserve_false_and_zero(self):
        # A weighted/any-pass verifier's recorded score can pass despite a failed
        # criterion; an unrelated failing score cannot override the selected one.
        rows = [{"id": 0, "result": False}, {"id": "zero", "result": 0},
                {"id": "yes", "result": True}]
        checks = [{"id": "0", "passed": False, "description": ""},
                  {"id": "zero", "passed": False, "description": ""},
                  {"id": "yes", "passed": True, "description": ""}]
        for score, expected in ((0, "scored below 1"), (0.5, "scored below 1"),
                                (1, "passed"), (1.5, "passed")):
            with self.subTest(score=score):
                verifications = {"other": {"score": 0},
                                 "wanted": {"results": rows, "score": score}}
                self.assertEqual(_solve_facts(run_with(verifications, "scored below 1"), "wanted"),
                                 (expected, checks))

    def test_failure_and_cancellation_preserve_partial_named_checks(self):
        for outcome in ("failed", "cancelled"):
            with self.subTest(outcome=outcome):
                run = run_with({"wanted": {"results": [{"id": "partial", "result": True}],
                                           "score": 1.0}}, outcome)
                self.assertEqual(_solve_facts(run, "wanted"),
                                 (outcome, [{"id": "partial", "passed": True, "description": ""}]))

    def test_non_numeric_or_nonfinite_scores_remain_unscored(self):
        for score in (None, True, "1", float("nan"), float("inf")):
            with self.subTest(score=score):
                run = run_with({"wanted": {"results": [{"id": "yes", "result": True}],
                                           "score": score}})
                self.assertEqual(_solve_facts(run, "wanted")[0], "unscored")


if __name__ == "__main__":
    unittest.main()
