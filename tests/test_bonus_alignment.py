from api_test_case import ApiTestCase


class TestBonusAlignment(ApiTestCase):
    def test_final_demo_seed_has_one_longitudinal_and_one_clean_patient(self):
        _, patients = self.request("GET", "/api/patients")
        self.assertEqual(
            {patient["displayName"] for patient in patients},
            {"Mr Chen (synthetic)", "Ms Taylor (synthetic)"},
        )

        _, mr_chen = self.request("GET", "/api/patients/P-1001")
        _, ms_taylor = self.request("GET", "/api/patients/P-1002")
        self.assertEqual(mr_chen["highlights"], [])
        self.assertEqual(mr_chen["tasks"], [])
        self.assertEqual(mr_chen["prescriptions"], [])
        self.assertTrue(mr_chen["archiveBuckets"])
        self.assertTrue(any(entry["type"] == "allergy_verification" for entry in mr_chen["entries"]))
        self.assertEqual(ms_taylor["entries"], [])
        self.assertEqual(ms_taylor["highlights"], [])
        self.assertEqual(ms_taylor["tasks"], [])

    def test_admin_can_restore_demo_seed_but_clinician_cannot(self):
        self.request(
            "POST",
            "/api/entries",
            body={"patientId": "P-1001", "summary": "Temporary test activity."},
        )
        forbidden, _ = self.request("POST", "/api/admin/reset-demo", body={})
        self.assertEqual(forbidden, 403)
        status, result = self.request(
            "POST", "/api/admin/reset-demo", role="admin", body={}
        )
        self.assertEqual(status, 200)
        self.assertEqual(result["profile"], "final-demo-start")
        self.assertEqual(result["patientCount"], 2)
        self.assertEqual(result["entryCount"], 3)

    def register_second_patient(self):
        status, payload = self.request(
            "POST",
            "/api/auth/register-patient",
            role=None,
            body={
                "title": "Ms",
                "givenName": "Taylor",
                "familyName": "Demo",
                "age": 41,
                "pronouns": "she/her",
                "syntheticConfirmed": True,
            },
        )
        self.assertEqual(status, 201)
        return payload["patient"]["id"]

    def submit_cough_report(self, patient_id):
        status, _ = self.request(
            "POST",
            "/api/patient-sessions",
            role="patient",
            body={"patientId": patient_id, "message": "I have had a cough for three months."},
        )
        self.assertEqual(status, 201)

    def test_team_learning_transfers_to_similar_content_for_another_patient(self):
        second_patient_id = self.register_second_patient()
        self.submit_cough_report("P-1001")
        self.submit_cough_report(second_patient_id)

        _, first_view = self.request("GET", "/api/patients/P-1001")
        _, second_before = self.request("GET", f"/api/patients/{second_patient_id}")
        first_highlight = first_view["highlights"][0]
        second_initial = second_before["highlights"][0]

        status, _ = self.request(
            "POST", f'/api/highlights/{first_highlight["id"]}/pin', body={}
        )
        self.assertEqual(status, 200)

        _, second_after = self.request("GET", f"/api/patients/{second_patient_id}")
        learned = second_after["highlights"][0]
        self.assertEqual(learned["score"], second_initial["score"] + 10)
        self.assertEqual(learned["breakdown"]["teamLearning"], 10)
        self.assertTrue(
            any(
                signal["key"] == "symptom:cough" and signal["weight"] == 10
                for signal in learned["matchedSignals"]
            )
        )
        self.assertIn("never turns", learned["policy"])

    def test_team_comment_is_a_smaller_learning_signal(self):
        self.submit_cough_report("P-1001")
        _, before = self.request("GET", "/api/patients/P-1001")
        highlight = before["highlights"][0]
        status, _ = self.request(
            "POST",
            f'/api/entries/{highlight["entryId"]}/comments',
            body={"body": "@clinician this symptom pattern is worth reviewing."},
        )
        self.assertEqual(status, 201)
        _, after = self.request("GET", "/api/patients/P-1001")
        self.assertEqual(after["highlights"][0]["score"], highlight["score"] + 2)

    def test_old_low_priority_note_is_collapsed_without_deletion(self):
        status, old_note = self.request(
            "POST",
            "/api/entries",
            body={
                "patientId": "P-1001",
                "type": "clinician_note",
                "status": "resolved",
                "occurredAt": "2020-01-12T09:00:00+08:00",
                "summary": "Historical low-priority synthetic context.",
                "plan": "No open action.",
            },
        )
        self.assertEqual(status, 201)

        _, care_note = self.request("GET", "/api/patients/P-1001")
        retained = next(entry for entry in care_note["entries"] if entry["id"] == old_note["id"])
        self.assertEqual(retained["storage"]["tier"], "cold")
        self.assertTrue(retained["storage"]["defaultCollapsed"])
        self.assertTrue(retained["storage"]["rawSourceRetained"])
        self.assertTrue(
            any(old_note["id"] in bucket["entryIds"] for bucket in care_note["archiveBuckets"])
        )
        self.assertEqual(care_note["storagePolicy"]["mode"], "non-destructive-tiering")

    def test_old_safety_fact_never_decays(self):
        _, care_note = self.request("GET", "/api/patients/P-1001")
        allergy = next(entry for entry in care_note["entries"] if entry["id"] == "E-ALLERGY-01")
        self.assertEqual(allergy["storage"]["tier"], "hot")
        self.assertIn("Persistent safety", allergy["storage"]["reason"])
