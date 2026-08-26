from api_test_case import ApiTestCase


class TestSelfLearningImportance(ApiTestCase):
    def test_pinned_highlight_increases_future_similar_priority(self):
        self.request(
            "POST",
            "/api/patient-sessions",
            role="patient",
            body={"patientId": "P-1001", "message": "I feel dizzy and take glucose."},
        )
        _, before = self.request("GET", "/api/patients/P-1001")
        initial = before["highlights"][0]

        status, pinned = self.request(
            "POST", f'/api/highlights/{initial["id"]}/pin', role="clinician", body={}
        )
        self.assertEqual(status, 200)
        self.assertEqual(pinned["status"], "accepted")
        self.assertEqual(pinned["learnedWeight"], 10)
        self.assertFalse(pinned.get("confirmsClinicalTruth", False))

        _, after = self.request("GET", "/api/patients/P-1001")
        self.assertEqual(after["highlights"][0]["score"], initial["score"] + 10)

    def test_rejected_hypothesis_lowers_future_priority_without_rewriting_source(self):
        status, _ = self.request(
            "POST",
            "/api/patient-sessions",
            role="patient",
            body={
                "patientId": "P-1001",
                "message": "I feel dizzy and think it is low blood sugar, so glucose should help.",
            },
        )
        self.assertEqual(status, 201)
        _, before = self.request("GET", "/api/patients/P-1001")
        initial = before["highlights"][0]
        self.assertGreaterEqual(initial["score"], 50)
        self.assertEqual(initial["status"], "suggested")

        status, replaced = self.request(
            "POST",
            f'/api/highlights/{initial["id"]}/reject-and-replace',
            body={
                "reason": "Objective tests contradict the patient hypothesis.",
                "diagnosis": "Hyperglycemia confirmed; findings are consistent with diabetes.",
                "plan": "Start clinician-directed diabetes follow-up.",
                "patientSummary": "Your results show high, not low, blood sugar.",
                "patientPlan": "Please follow the clinician's diabetes care plan.",
            },
        )
        self.assertEqual(status, 200)
        self.assertEqual(replaced["highlight"]["status"], "rejected")
        self.assertEqual(replaced["highlight"]["learnedWeight"], -10)
        self.assertLess(replaced["highlight"]["futureSimilarScore"], initial["score"])
        self.assertEqual(replaced["clinicalEntry"]["authorRole"], "clinician")

        # The learned weight is a ranking signal. It does not rewrite the AI source
        # or turn later model output into a clinician-authored fact.
        _, after = self.request("GET", "/api/patients/P-1001")
        source_entry = next(entry for entry in after["entries"] if entry["id"] == initial["entryId"])
        self.assertEqual(source_entry["authorRole"], "system")
        self.assertEqual(source_entry["status"], "superseded")
        self.assertIn("suspects low blood sugar", source_entry["sections"]["summary"])
        self.assertEqual(after["highlights"], [])
