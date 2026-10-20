import unittest
from skill_lineage import inherited_reads, validate_transition


class SkillLineageTests(unittest.TestCase):
    def setUp(self):
        self.skill = {"name": "review", "description": "Review", "applicability": "Inbound", "content": "Read current policy", "evidence": "Observed source", "version": 1, "scope": "fixture", "origin": "agent-procedure", "createdAt": 1, "updatedAt": 1}

    def test_inherited_state_requires_no_synthetic_write(self):
        self.assertEqual(validate_transition([self.skill], [self.skill], [], "fixture"), [])

    def test_undispatched_change_and_cross_scope_are_detected(self):
        changed = {**self.skill, "content": "Different", "scope": "other"}
        self.assertTrue(validate_transition([self.skill], [changed], [], "fixture"))

    def test_multiple_real_updates_preserve_the_version_chain(self):
        calls = [{"name": "procedures_skill_save", "status": "completed", "input": {**self.skill, "content": f"Version {n + 1}", "expectedVersion": n}} for n in [1, 2]]
        after = {**self.skill, "content": "Version 3", "version": 3, "updatedAt": 3}
        self.assertEqual(validate_transition([self.skill], [after], calls, "fixture"), [])
        calls[1]["input"]["expectedVersion"] = 1
        self.assertTrue(validate_transition([self.skill], [after], calls, "fixture"))

    def test_failed_write_does_not_establish_new_content(self):
        call = {"name": "procedures_skill_save", "status": "failed", "input": {**self.skill, "content": "Failed", "expectedVersion": 1}}
        self.assertEqual(validate_transition([self.skill], [self.skill], [call], "fixture"), [])
        self.assertTrue(validate_transition([self.skill], [{**self.skill, "content": "Failed", "version": 2}], [call], "fixture"))

    def test_read_started_before_write_but_finished_after_is_not_prior_retrieval(self):
        call = {"name": "procedures_skill_view", "status": "completed", "id": "read", "input": {"name": "review"}}
        events = [{"seq": 1, "data": {"type": "tool.start", "id": "read", "name": call["name"]}}, {"seq": 2, "data": {"type": "tool.start", "id": "write", "name": "environment_helpdesk_update_ticket"}}, {"seq": 3, "data": {"type": "tool.result", "id": "read", "isError": False}}]
        self.assertFalse(inherited_reads([self.skill], [call], events)[0]["completedBeforeBusinessWrite"])
        events[-1]["seq"] = 1.5
        self.assertTrue(inherited_reads([self.skill], [call], events)[0]["completedBeforeBusinessWrite"])
        events[-1]["data"]["isError"] = True
        self.assertEqual(inherited_reads([self.skill], [call], events), [])


if __name__ == "__main__":
    unittest.main()
