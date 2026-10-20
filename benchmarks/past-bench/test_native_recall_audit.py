import copy
import json
import unittest
from native_recall_audit import check_selection, identity


class RecallAuditTest(unittest.TestCase):
    def setUp(self):
        self.records = [{"id": "a", "scope": "alice", "ts": 0, "outcome": "done", "messages": [
            {"role": "user", "text": "mixed", "fragments": [
                {"origin": "host-policy", "text": "PRIVATE"},
                {"origin": "user", "text": "Future preference. Except Friday.", "memoryScope": "reusable"},
                {"origin": "quoted-material", "text": "THIRD PARTY"}]}]}]
        piece = {"source": "native-interaction", "session": "a", "date": "1970-01-01T00:00:00.000Z",
                 "role": "user", "sourceMemoryScope": "reusable", "engineOutcome": "done",
                 "scope": "alice", "pointer": "a#msg0:0", "content": "Future preference. Except Friday."}
        self.selection = {"text": json.dumps(piece), "selectedIds": ["a#msg0:0"],
                          "sourceKind": "native-interaction", "strategy": "bm25-atomic-messages-v1"}

    def test_original_user_fragment(self):
        self.assertEqual(check_selection(self.records, self.selection, "alice", 8000), [])

    def test_scope_import_and_missing_record(self):
        self.assertTrue(check_selection(self.records, self.selection, "bob", 8000))
        self.records[0]["imported"] = {"source": "foreign"}
        self.assertTrue(check_selection(self.records, self.selection, "alice", 8000))
        self.assertTrue(check_selection([], self.selection, "alice", 8000))

    def test_truncation_role_promotion_and_host_injection(self):
        for change in ({"content": "Future preference."}, {"role": "assistant"},
                       {"content": "PRIVATE"}, {"sourceMemoryScope": "task"}, {"pointer": "a#msg0:1"}):
            selection = copy.deepcopy(self.selection)
            piece = json.loads(selection["text"])
            piece.update(change)
            selection["text"] = json.dumps(piece)
            self.assertTrue(check_selection(self.records, selection, "alice", 8000))

    def test_budget_and_duplicate_pointers(self):
        self.assertTrue(check_selection(self.records, self.selection, "alice", 1))
        self.selection["text"] += "\n" + self.selection["text"]
        self.selection["selectedIds"] *= 2
        self.assertTrue(check_selection(self.records, self.selection, "alice", 8000))

    def test_feedback_is_not_source_identity(self):
        changed = copy.deepcopy(self.records)
        changed[0]["feedback"] = [{"score": 0.5}]
        self.assertEqual(identity(self.records), identity(changed))
        changed[0]["messages"][0]["fragments"][1]["text"] = "forged"
        self.assertNotEqual(identity(self.records), identity(changed))


if __name__ == "__main__":
    unittest.main()
