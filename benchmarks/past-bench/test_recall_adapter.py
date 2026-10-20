import copy
import hashlib
import json
import unittest
from recall_adapter import action_effects, memory_call_counts, project_recall, validate_report


class RecallAdapterTest(unittest.TestCase):
    def test_readiness_and_failed_memory_calls_never_become_successful_reads(self):
        calls = [{"name": "direct_memory_memory_ready", "status": "completed"},
                 {"name": "direct_memory_memory_search", "status": "failed"},
                 {"name": "direct_memory_memory_search", "status": "completed"},
                 {"name": "direct_memory_memory_add", "status": "failed"}]
        self.assertEqual(memory_call_counts(calls), {"memory_calls": 1, "memory_read_count": 1, "memory_write_count": 0})
        self.assertEqual(action_effects(["notes_get", "notes_share", "new_tool"]),
                         {"environment_notes_get": "read", "environment_notes_share": "write", "environment_new_tool": "unknown"})

    def fixture(self):
        source = {"id": "exp-a#msg0:0", "role": "user"}
        context = json.dumps({"name": "quoted-material-1", "text": "source"}, separators=(",", ":"))
        digest = hashlib.sha256(b"source").hexdigest()
        selection = {"recallId": "r", "kind": "native-history", "contextName": "quoted-material-1", "sources": [source], "contentSha256": digest}
        request = 'Host-provided reference data\n' + json.dumps({"reference": context}, separators=(",", ":")) + '\n\nCurrent user request:\n\nDo the task.'
        events = [
            {"seq": 0, "type": "recall.policy", "data": {"schemaVersion": 1, "reads": {}, "actionEffects": {"publish": "write"}}},
            {"seq": 1, "type": "session.create.end", "data": {"sessionId": "host-a", "spanId": "conn-a"}},
            {"seq": 2, "type": "recall.selection", "turnId": "t", "data": selection},
            {"seq": 3, "type": "prompt.assembled", "turnId": "t", "data": {"contexts": [{"name": "quoted-material-1", "text": "source"}]}},
            {"seq": 4, "type": "turn.start", "turnId": "t", "sessionId": "host-a", "data": {"input": {"text": "Do the task.", "context": context}}},
            {"seq": 5, "type": "adapter.protocol", "data": {"connectionId": "conn-a", "direction": "out", "data": {"method": "session/prompt", "params": {"prompt": [{"type": "text", "text": request}]}}}},
            {"seq": 6, "type": "agent.event", "turnId": "t", "data": {"type": "tool.start", "id": "w", "name": "publish"}},
        ]
        evidence = {"turnId": "t", "recallId": "r", "kind": "native-history", "method": "context", "outcome": "hit", "sources": [source], "selectionSequence": 2, "availableSequence": 5, "delivery": "captured-request", "beforeFirstWrite": True, "firstKnownWriteSequence": 6, "issues": []}
        return {"schemaVersion": 1, "status": "observed", "evidence": [evidence], "issues": []}, events

    def test_history_is_projected_as_history_without_legacy_memory_override(self):
        report, events = self.fixture()
        self.assertEqual(validate_report(report, events, "t"), [])
        mapped = project_recall(report, "t")
        self.assertFalse(mapped["legacyScoreOverride"])
        self.assertEqual(mapped["byKind"]["native-history"]["capturedContextInjections"], 1)
        self.assertEqual(mapped["byKind"]["memory"]["capturedContextInjections"], 0)
        self.assertEqual(project_recall(None, "t")["status"], "unavailable")

    def test_rejects_wrong_connection_order_or_removed_source(self):
        for mode in ["connection", "order", "source", "identity"]:
            report, events = self.fixture()
            if mode == "connection":
                events[5]["data"]["connectionId"] = "other"
            elif mode == "order":
                report["evidence"][0]["availableSequence"] = 7
            elif mode == "source":
                context = '{"name":"quoted-material-1","text":"changed"}'
                events[4]["data"]["input"]["context"] = context
                events[5]["data"]["data"]["params"]["prompt"][0]["text"] = json.dumps({"reference": context}, separators=(",", ":")) + '\n\nCurrent user request:\n\nDo the task.'
            else:
                report["evidence"][0]["recallId"] = "forged"
            self.assertTrue(validate_report(report, events, "t"), mode)

    def test_filters_other_turns_instead_of_reusing_aggregate_counts(self):
        report, _ = self.fixture()
        report["evidence"].append({**copy.deepcopy(report["evidence"][0]), "turnId": "other"})
        self.assertEqual(project_recall(report, "t")["byKind"]["native-history"]["capturedContextInjections"], 1)


if __name__ == "__main__":
    unittest.main()
