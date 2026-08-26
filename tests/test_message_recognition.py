from api_test_case import ApiTestCase, MockLlmHandler


class TestMessageRecognition(ApiTestCase):
    def test_top_card_title_keeps_symptom_and_duration(self):
        highlight, _ = self.generated_text_for("Cough for three months")
        self.assertIn("cough", highlight["title"].lower())
        self.assertIn("three months", highlight["title"].lower())

    def generated_text_for(self, message):
        self.request("POST", "/api/test/reset", role=None)
        status, _ = self.request(
            "POST",
            "/api/patient-sessions",
            role="patient",
            body={"patientId": "P-1001", "message": message},
        )
        self.assertEqual(status, 201)
        _, care_note = self.request("GET", "/api/patients/P-1001")
        highlight = care_note["highlights"][0]
        entry = next(item for item in care_note["entries"] if item["id"] == highlight["entryId"])
        return highlight, entry

    def test_different_messages_generate_different_clinical_summaries(self):
        cases = [
            (
                "I have a fever and cough. I think it may be flu, and I took paracetamol.",
                ["fever", "cough", "influenza", "paracetamol"],
                ["low blood sugar", "dizziness", "glucose"],
            ),
            (
                "My headache keeps happening and I suspect migraine.",
                ["headache", "migraine"],
                ["low blood sugar", "glucose"],
            ),
            (
                "I sometimes feel dizzy. I think it is low blood sugar, so I take glucose.",
                ["dizziness", "low blood sugar", "glucose"],
                ["influenza", "cough"],
            ),
        ]
        for message, expected, forbidden in cases:
            with self.subTest(message=message):
                highlight, entry = self.generated_text_for(message)
                generated = f'{highlight["title"]} {entry["sections"]["summary"]}'.lower()
                for term in expected:
                    self.assertIn(term, generated)
                for term in forbidden:
                    self.assertNotIn(term, generated)

    def test_unknown_wording_uses_the_message_instead_of_inventing_a_diagnosis(self):
        highlight, entry = self.generated_text_for(
            "There is an unusual clicking feeling in my left knee after gardening."
        )
        generated = f'{highlight["title"]} {entry["sections"]["summary"]}'.lower()
        self.assertIn("clicking feeling", generated)
        self.assertNotIn("low blood sugar", generated)
        self.assertEqual(highlight["category"], "patient_reported_concern")

    def test_highlight_source_is_an_exact_excerpt_of_patient_wording(self):
        message = "I slept poorly. My chest feels tight and I have difficulty breathing. Please help."
        highlight, entry = self.generated_text_for(message)
        span = next(item for item in entry["spans"] if item["id"] == highlight["spanId"])
        self.assertIn(span["text"], message)
        self.assertEqual(message[span["startChar"]:span["endChar"]], span["text"])
        self.assertGreaterEqual(highlight["baseScore"], 88)

    def test_follow_up_task_also_matches_the_recognised_concern(self):
        highlight, _ = self.generated_text_for(
            "I have a fever and cough. I think it may be flu, and I took paracetamol."
        )
        suggestion = highlight["suggestedTask"]
        self.assertEqual(suggestion["resultType"], "respiratory_assessment")
        self.assertIn("respiratory", suggestion["title"].lower())
        self.assertNotIn("glucose", str(suggestion).lower())

        status, task = self.request(
            "POST",
            "/api/tasks",
            body={
                "patientId": "P-1001",
                "sourceHighlightId": highlight["id"],
                **suggestion,
            },
        )
        self.assertEqual(status, 201)
        self.request(
            "PATCH",
            f'/api/tasks/{task["id"]}',
            role="staff",
            body={"status": "scheduled", "scheduledAt": "2026-08-27T09:30:00+08:00"},
        )
        status, completed = self.request(
            "PATCH",
            f'/api/tasks/{task["id"]}',
            role="staff",
            body={
                "status": "result_ready",
                "results": {"outcome": "Temperature 38.2 C; respiratory assessment completed."},
            },
        )
        self.assertEqual(status, 200)
        self.assertIn("38.2", completed["results"]["outcome"])
        self.assertNotIn("fastingGlucose", completed["results"])

    def test_phi_is_redacted_before_the_external_structured_output_call(self):
        MockLlmHandler.requests.clear()
        status, _ = self.request(
            "POST",
            "/api/patient-sessions",
            role="patient",
            body={
                "patientId": "P-1001",
                "message": "Alice feels dizzy. Call +65 9123 4567.",
                "knownNames": ["Alice"],
            },
        )
        self.assertEqual(status, 201)
        self.assertGreaterEqual(len(MockLlmHandler.requests), 2)
        for llm_request in MockLlmHandler.requests:
            self.assertNotIn("Alice", llm_request["input"])
            self.assertNotIn("9123 4567", llm_request["input"])
            self.assertIn("[REDACTED_NAME]", llm_request["input"])
            self.assertIn("[REDACTED_PHONE]", llm_request["input"])
            self.assertFalse(llm_request["store"])
        analysis_request = next(
            request for request in MockLlmHandler.requests
            if request.get("text", {}).get("format", {}).get("name") == "patient_message_analysis"
        )
        self.assertEqual(analysis_request["text"]["format"]["type"], "json_schema")
