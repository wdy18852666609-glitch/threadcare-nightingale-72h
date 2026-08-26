from api_test_case import ApiTestCase


class TestHighlightProvenance(ApiTestCase):
    def test_every_highlight_resolves_to_exact_entry_span(self):
        status, _ = self.request(
            "POST",
            "/api/patient-sessions",
            role="patient",
            body={
                "patientId": "P-1001",
                "message": "I feel dizzy. I think it is low blood sugar and glucose will help.",
            },
        )
        self.assertEqual(status, 201)
        status, care_note = self.request("GET", "/api/patients/P-1001")
        self.assertEqual(status, 200)
        self.assertTrue(care_note["highlights"])

        for highlight in care_note["highlights"]:
            status, source = self.request(
                "GET", f'/api/entries/{highlight["entryId"]}/source'
            )
            self.assertEqual(status, 200)
            self.assertEqual(source["entryId"], highlight["entryId"])
            self.assertIn(highlight["spanId"], [span["id"] for span in source["spans"]])
