from api_test_case import ApiTestCase


class TestRevisionHistory(ApiTestCase):
    def create_clinician_note(self):
        status, note = self.request(
            "POST",
            "/api/entries",
            body={
                "patientId": "P-1001",
                "summary": "Initial assessment",
                "plan": "Initial plan",
                "type": "clinician_note",
            },
        )
        self.assertEqual(status, 201)
        return note

    def test_edit_increments_version_and_revert_restores_content(self):
        note = self.create_clinician_note()
        status, edited = self.request(
            "PATCH",
            f'/api/entries/{note["id"]}/sections/summary',
            body={"content": "Updated assessment", "baseVersion": 1},
        )
        self.assertEqual(status, 200)
        self.assertEqual(edited["entry"]["version"], 2)

        status, reverted = self.request(
            "POST",
            f'/api/entries/{note["id"]}/revert',
            body={"targetVersion": 1},
        )
        self.assertEqual(status, 200)
        self.assertEqual(reverted["sections"]["summary"], "Initial assessment")

    def test_audit_log_contains_metadata_not_note_content(self):
        note = self.create_clinician_note()
        secret_content = "Sensitive narrative must not appear in metadata logs"
        self.request(
            "PATCH",
            f'/api/entries/{note["id"]}/sections/summary',
            body={"content": secret_content, "baseVersion": 1},
        )
        status, events = self.request("GET", "/api/audit", role="admin")
        self.assertEqual(status, 200)
        self.assertNotIn(secret_content, str(events))
        self.assertTrue(any(event["action"] == "entry.section_edited" for event in events))
