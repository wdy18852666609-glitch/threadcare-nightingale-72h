from api_test_case import ApiTestCase


class TestConversationsAndConsultation(ApiTestCase):
    def test_same_day_ai_intake_updates_one_timeline_summary(self):
        for message in ("I feel dizzy today.", "It started after lunch and lasted ten minutes."):
            status, _ = self.request(
                "POST",
                "/api/patient-sessions",
                role="patient",
                body={"patientId": "P-1001", "message": message},
            )
            self.assertEqual(status, 201)

        _, clinician_view = self.request("GET", "/api/patients/P-1001")
        daily_summaries = [
            entry for entry in clinician_view["entries"]
            if entry["type"] == "ai_patient_session_summary" and entry["status"] == "needs_review"
        ]
        self.assertEqual(len(daily_summaries), 1)
        self.assertEqual(daily_summaries[0]["version"], 2)
        self.assertEqual(len(daily_summaries[0]["spans"]), 4)
        self.assertEqual(
            [span["authorRole"] for span in daily_summaries[0]["spans"]],
            ["patient", "system", "patient", "system"],
        )
        self.assertTrue(all(span["messageBody"] for span in daily_summaries[0]["spans"]))

    def test_scheduled_task_becomes_patient_reminder(self):
        _, task = self.request(
            "POST",
            "/api/tasks",
            role="clinician",
            body={
                "patientId": "P-1001",
                "title": "Manually entered test",
                "rationale": "Manually entered staff instructions",
                "resultType": "general_assessment",
            },
        )
        scheduled_at = "2026-08-27T09:30:00+08:00"
        status, _ = self.request(
            "PATCH",
            f'/api/tasks/{task["id"]}',
            role="staff",
            body={"status": "scheduled", "scheduledAt": scheduled_at},
        )
        self.assertEqual(status, 200)

        _, patient_view = self.request("GET", "/api/patients/P-1001", role="patient")
        self.assertEqual(len(patient_view["tasks"]), 1)
        reminder = patient_view["tasks"][0]
        self.assertEqual(reminder["title"], "Manually entered test")
        self.assertTrue(reminder["scheduledAt"])
        self.assertNotIn("rationale", reminder)

    def test_ai_intake_and_direct_clinician_chat_are_role_scoped(self):
        status, intake = self.request(
            "POST",
            "/api/patient-sessions",
            role="patient",
            body={"patientId": "P-1001", "message": "I feel dizzy today."},
        )
        self.assertEqual(status, 201)
        self.assertEqual([item["authorRole"] for item in intake["conversationMessages"]], ["patient", "system"])

        status, _ = self.request(
            "POST",
            "/api/conversations/C-PATIENT-CLINICIAN/messages",
            role="clinician",
            body={"body": "I reviewed your report. When did the dizziness begin?"},
        )
        self.assertEqual(status, 201)
        _, patient_conversations = self.request("GET", "/api/conversations?patientId=P-1001", role="patient")
        direct = next(item for item in patient_conversations if item["id"] == "C-PATIENT-CLINICIAN")
        self.assertIn("When did", direct["messages"][0]["body"])
        self.assertNotIn("C-CLINICAL-TEAM", [item["id"] for item in patient_conversations])

    def test_team_chat_can_be_summarized_with_exact_message_sources(self):
        self.request(
            "POST",
            "/api/conversations/C-CLINICAL-TEAM/messages",
            role="clinician",
            body={"body": "Maya, please arrange fasting glucose and HbA1c tests."},
        )
        self.request(
            "POST",
            "/api/conversations/C-CLINICAL-TEAM/messages",
            role="staff",
            body={"body": "Scheduled for tomorrow morning."},
        )
        status, summary = self.request(
            "POST", "/api/conversations/C-CLINICAL-TEAM/summarize", role="clinician"
        )
        self.assertEqual(status, 200)
        self.assertEqual(summary["authorRole"], "system")
        self.assertEqual(summary["type"], "ai_clinical_team_summary")
        self.assertEqual(len(summary["spans"]), 2)
        self.assertTrue(all(span["messageId"] for span in summary["spans"]))

        status, _ = self.request(
            "POST", "/api/conversations/C-CLINICAL-TEAM/summarize", role="patient"
        )
        self.assertEqual(status, 403)

    def test_doctor_and_nurse_consults_create_distinct_ai_scribe_types(self):
        self.request(
            "POST",
            "/api/conversations/C-PATIENT-CLINICIAN/messages",
            role="clinician",
            body={"body": "When did the cough begin?"},
        )
        self.request(
            "POST",
            "/api/conversations/C-PATIENT-CLINICIAN/messages",
            role="patient",
            body={"body": "About three months ago."},
        )
        status, doctor_summary = self.request(
            "POST", "/api/conversations/C-PATIENT-CLINICIAN/summarize", role="clinician"
        )
        self.assertEqual(status, 200)
        self.assertEqual(doctor_summary["type"], "ai_doctor_consult_summary")

        self.request(
            "POST",
            "/api/conversations/C-PATIENT-STAFF/messages",
            role="patient",
            body={"body": "Is my appointment confirmed?"},
        )
        self.request(
            "POST",
            "/api/conversations/C-PATIENT-STAFF/messages",
            role="staff",
            body={"body": "Yes, please arrive ten minutes early."},
        )
        status, nurse_summary = self.request(
            "POST", "/api/conversations/C-PATIENT-STAFF/summarize", role="staff"
        )
        self.assertEqual(status, 200)
        self.assertEqual(nurse_summary["type"], "ai_nurse_consult_summary")
        self.assertEqual([span["authorRole"] for span in nurse_summary["spans"]], ["patient", "staff"])

        status, _ = self.request(
            "POST",
            "/api/conversations/C-PATIENT-STAFF/messages",
            role="clinician",
            body={"body": "Clinician cannot impersonate nurse."},
        )
        self.assertEqual(status, 403)

    def test_clinician_outcome_and_prescription_are_patient_visible(self):
        status, closed = self.request(
            "POST",
            "/api/consultations/close",
            role="clinician",
            body={
                "patientId": "P-1001",
                "assessment": "Hyperglycemia confirmed after clinician review of synthetic results.",
                "advice": "Discuss diabetes education and arrange follow-up within one week.",
                "medications": [{
                    "name": "Metformin (synthetic)",
                    "dose": "500 mg",
                    "frequency": "Once daily",
                    "instructions": "Take with food as directed by the clinician.",
                }],
            },
        )
        self.assertEqual(status, 201)
        self.assertEqual(closed["consultation"]["status"], "closed")
        self.assertEqual(len(closed["prescriptions"]), 1)

        _, patient_view = self.request("GET", "/api/patients/P-1001", role="patient")
        self.assertTrue(any(entry["type"] == "consultation_outcome" for entry in patient_view["entries"]))
        self.assertEqual(patient_view["prescriptions"][0]["name"], "Metformin (synthetic)")
