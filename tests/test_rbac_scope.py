from api_test_case import ApiTestCase


class TestRbacScope(ApiTestCase):
    def test_patient_cannot_receive_internal_notes_comments_or_ai_sources(self):
        self.request(
            "POST",
            "/api/patient-sessions",
            role="patient",
            body={
                "patientId": "P-1001",
                "message": "I feel dizzy and think it is low blood sugar, so glucose should help.",
            },
        )
        status, patient_view = self.request("GET", "/api/patients/P-1001", role="patient")
        self.assertEqual(status, 200)
        self.assertTrue(patient_view["entries"])
        self.assertTrue(all(entry["visibility"] == "patient" for entry in patient_view["entries"]))
        self.assertEqual(patient_view["comments"], [])
        self.assertEqual(patient_view["highlights"], [])

        _, clinician_view = self.request("GET", "/api/patients/P-1001")
        ai_entry_id = clinician_view["highlights"][0]["entryId"]
        status, _ = self.request(
            "GET", f"/api/entries/{ai_entry_id}/source", role="patient"
        )
        self.assertEqual(status, 403)

    def test_staff_and_clinician_cannot_overwrite_each_others_notes(self):
        status, note = self.request(
            "POST",
            "/api/entries",
            role="staff",
            body={"patientId": "P-1001", "summary": "Appointment arranged", "plan": "Await patient"},
        )
        self.assertEqual(status, 201)

        status, _ = self.request(
            "PATCH",
            f'/api/entries/{note["id"]}/sections/summary',
            role="clinician",
            body={"content": "Clinician silently rewrites staff", "baseVersion": 1},
        )
        self.assertEqual(status, 403)

    def test_scope_is_enforced_by_server(self):
        status, _ = self.request(
            "GET", "/api/patients/P-1001", role="clinician", clinic="clinic-other"
        )
        self.assertEqual(status, 403)

    def test_only_clinician_can_decide_ai_highlight(self):
        self.request(
            "POST",
            "/api/patient-sessions",
            role="patient",
            body={"patientId": "P-1001", "message": "Dizzy; I suspect low blood sugar."},
        )
        _, care_note = self.request("GET", "/api/patients/P-1001")
        highlight_id = care_note["highlights"][0]["id"]
        status, _ = self.request(
            "POST",
            f"/api/highlights/{highlight_id}/reject-and-replace",
            role="staff",
            body={
                "diagnosis": "Hyperglycemia confirmed",
                "patientSummary": "Your test results need clinician follow-up.",
            },
        )
        self.assertEqual(status, 403)

        status, _ = self.request(
            "POST", f"/api/highlights/{highlight_id}/pin", role="staff", body={}
        )
        self.assertEqual(status, 403)

    def test_staff_and_clinician_each_own_their_manual_notes(self):
        _, staff_note = self.request(
            "POST",
            "/api/entries",
            role="staff",
            body={"patientId": "P-1001", "summary": "Staff observation", "plan": "Initial staff plan"},
        )
        status, edited = self.request(
            "PATCH",
            f'/api/entries/{staff_note["id"]}/sections/plan',
            role="staff",
            body={"content": "Updated staff plan", "baseVersion": 1},
        )
        self.assertEqual(status, 200)
        self.assertEqual(edited["entry"]["authorRole"], "staff")

        status, _ = self.request(
            "PATCH",
            f'/api/entries/{staff_note["id"]}/sections/plan',
            role="clinician",
            body={"content": "Clinician overwrite", "baseVersion": 2},
        )
        self.assertEqual(status, 403)
        status, _ = self.request(
            "POST",
            f'/api/entries/{staff_note["id"]}/revert',
            role="clinician",
            body={"targetVersion": 1},
        )
        self.assertEqual(status, 403)
        status, reverted = self.request(
            "POST",
            f'/api/entries/{staff_note["id"]}/revert',
            role="staff",
            body={"targetVersion": 1},
        )
        self.assertEqual(status, 200)
        self.assertEqual(reverted["sections"]["plan"], "Initial staff plan")
