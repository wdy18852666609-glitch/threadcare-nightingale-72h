from api_test_case import ApiTestCase


class TestConcurrentEdits(ApiTestCase):
    def create_note(self):
        status, note = self.request(
            "POST",
            "/api/entries",
            body={"patientId": "P-1001", "summary": "S1", "plan": "P1"},
        )
        self.assertEqual(status, 201)
        return note

    def test_different_sections_do_not_overwrite_each_other(self):
        note = self.create_note()
        status, _ = self.request(
            "PATCH",
            f'/api/entries/{note["id"]}/sections/summary',
            body={"content": "S2", "baseVersion": 1},
        )
        self.assertEqual(status, 200)

        status, result = self.request(
            "PATCH",
            f'/api/entries/{note["id"]}/sections/plan',
            body={"content": "P2", "baseVersion": 1},
        )
        self.assertEqual(status, 200)
        self.assertEqual(result["entry"]["sections"], {"summary": "S2", "plan": "P2"})

    def test_same_section_uses_deterministic_conflict_response(self):
        note = self.create_note()
        self.request(
            "PATCH",
            f'/api/entries/{note["id"]}/sections/summary',
            body={"content": "First writer", "baseVersion": 1},
        )
        status, conflict = self.request(
            "PATCH",
            f'/api/entries/{note["id"]}/sections/summary',
            body={"content": "Stale second writer", "baseVersion": 1},
        )
        self.assertEqual(status, 409)
        self.assertIn("conflict", conflict["error"].lower())
