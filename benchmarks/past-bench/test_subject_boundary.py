import copy
import unittest
import tempfile
from pathlib import Path
from subject_boundary import ISOLATION_PROTOCOL, new_subject_scopes, validate_scope_map, validate_workspace


class SubjectBoundaryTest(unittest.TestCase):
    def setUp(self):
        self.families = ["memory_ability/SM02_constraint_retention", "procedural_ability/PC04_failure_to_rule_01"]
        self.isolation = {"protocol": ISOLATION_PROTOCOL, "scopes": new_subject_scopes(self.families)}

    def test_random_namespaces_without_semantic_labels(self):
        self.assertEqual(validate_scope_map(self.isolation, self.families), [])
        other = new_subject_scopes(self.families)
        self.assertTrue(set(other.values()).isdisjoint(self.isolation["scopes"].values()))
        for value in self.isolation["scopes"].values():
            self.assertNotIn("SM02", value)
            self.assertNotIn("PC04", value)

    def test_rejects_label_reintroduction_and_cross_family_aliasing(self):
        for values in (["SM02_constraint_retention", "PC04_failure_to_rule_01"], ["ctx-" + "a" * 32] * 2):
            changed = copy.deepcopy(self.isolation)
            changed["scopes"] = dict(zip(self.families, values))
            self.assertTrue(validate_scope_map(changed, self.families))

    def test_rejects_missing_or_unplanned_scope(self):
        self.assertTrue(validate_scope_map(self.isolation, self.families[:1]))
        self.assertTrue(validate_scope_map(self.isolation, self.families + ["extra"]))
        with self.assertRaises(ValueError):
            new_subject_scopes(self.families * 2)

    def test_checks_actual_engine_and_experience_workspaces(self):
        workspace = str(Path(tempfile.gettempdir()) / "mentat-task-Ab12cd")
        experience = [{"cwd": workspace}]
        self.assertEqual(validate_workspace(workspace, [workspace], experience), [])
        self.assertTrue(validate_workspace(workspace, [], experience))
        self.assertTrue(validate_workspace(workspace, ["/somewhere/SM02"], experience))
        self.assertTrue(validate_workspace(workspace, [workspace], [{"cwd": "/other"}]))
        labelled = str(Path(tempfile.gettempdir()) / "SM02_constraint_retention" / "mentat-task-Ab12cd")
        self.assertTrue(validate_workspace(labelled, [labelled], [{"cwd": labelled}]))


if __name__ == "__main__":
    unittest.main()
