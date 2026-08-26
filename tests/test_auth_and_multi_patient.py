import json
import urllib.error
import urllib.request

from api_test_case import ApiTestCase


class TestAuthAndMultiPatient(ApiTestCase):
    def auth_request(self, method, path, body=None, cookie=None):
        headers = {"Content-Type": "application/json"}
        if cookie:
            headers["Cookie"] = cookie
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=json.dumps(body).encode() if body is not None else None,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                return response.status, json.loads(response.read() or b"{}"), response.headers.get("Set-Cookie")
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read() or b"{}"), error.headers.get("Set-Cookie")

    def test_protected_routes_require_a_server_session(self):
        status, payload, _ = self.auth_request("GET", "/api/patients")
        self.assertEqual(status, 401)
        self.assertIn("sign in", payload["error"].lower())

    def test_team_password_creates_role_bound_session(self):
        bad_status, _, _ = self.auth_request("POST", "/api/auth/login", {"role": "clinician", "password": "wrong"})
        self.assertEqual(bad_status, 401)
        status, payload, set_cookie = self.auth_request("POST", "/api/auth/login", {"role": "clinician", "password": "clinician123"})
        self.assertEqual(status, 200)
        self.assertEqual(payload["account"]["role"], "clinician")
        cookie = set_cookie.split(";", 1)[0]
        patients_status, patients, _ = self.auth_request("GET", "/api/patients", cookie=cookie)
        self.assertEqual(patients_status, 200)
        self.assertEqual(patients[0]["id"], "P-1001")

    def test_two_staff_accounts_keep_distinct_identity_and_shared_patient_access(self):
        cookies = {}
        for username, password in (("maya", "staff123"), ("noah", "staff456")):
            status, payload, set_cookie = self.auth_request(
                "POST", "/api/auth/login", {"role": "staff", "username": username, "password": password}
            )
            self.assertEqual(status, 200)
            self.assertEqual(payload["account"]["username"], username)
            cookies[username] = set_cookie.split(";", 1)[0]

        _, conversations, _ = self.auth_request("GET", "/api/conversations?patientId=P-1001", cookie=cookies["maya"])
        team_chat = next(item for item in conversations if item["kind"] == "clinical_team")
        for username in ("maya", "noah"):
            status, _, _ = self.auth_request(
                "POST",
                f"/api/conversations/{team_chat['id']}/messages",
                {"body": f"Update from {username}."},
                cookie=cookies[username],
            )
            self.assertEqual(status, 201)

        _, updated, _ = self.auth_request("GET", "/api/conversations?patientId=P-1001", cookie=cookies["noah"])
        messages = next(item for item in updated if item["kind"] == "clinical_team")["messages"]
        self.assertEqual([message["authorId"] for message in messages], ["staff-maya", "staff-noah"])
        self.assertEqual([message["authorName"] for message in messages], ["Nurse Maya", "Nurse Noah"])

    def test_ten_registered_patients_receive_unique_isolated_records(self):
        patient_ids = []
        last_cookie = None
        for index in range(10):
            status, registered, set_cookie = self.auth_request(
                "POST",
                "/api/auth/register-patient",
                {
                    "title": "Mx",
                    "givenName": f"Demo{index}",
                    "familyName": "Patient",
                    "age": 20 + index,
                    "pronouns": "they/them",
                    "syntheticConfirmed": True,
                },
            )
            self.assertEqual(status, 201)
            patient_ids.append(registered["patient"]["id"])
            last_cookie = set_cookie.split(";", 1)[0]
        self.assertEqual(len(set(patient_ids)), 10)

        own_status, _, _ = self.auth_request("GET", f"/api/patients/{patient_ids[-1]}", cookie=last_cookie)
        other_status, _, _ = self.auth_request("GET", f"/api/patients/{patient_ids[0]}", cookie=last_cookie)
        self.assertEqual(own_status, 200)
        self.assertEqual(other_status, 403)

        _, _, clinician_cookie_header = self.auth_request("POST", "/api/auth/login", {"role": "clinician", "username": "dr.lee", "password": "clinician123"})
        _, patients, _ = self.auth_request("GET", "/api/patients", cookie=clinician_cookie_header.split(";", 1)[0])
        self.assertEqual(len(patients), 12)

    def test_new_patient_is_isolated_and_visible_to_clinician(self):
        status, registered, patient_cookie_header = self.auth_request(
            "POST",
            "/api/auth/register-patient",
            {
                "title": "Ms",
                "givenName": "Jamie",
                "familyName": "Jason",
                "age": 42,
                "pronouns": "she/her",
                "phone": "0000 0000",
                "syntheticConfirmed": True,
            },
        )
        self.assertEqual(status, 201)
        new_id = registered["patient"]["id"]
        self.assertNotEqual(new_id, "P-1001")
        patient_cookie = patient_cookie_header.split(";", 1)[0]

        own_status, own_record, _ = self.auth_request("GET", f"/api/patients/{new_id}", cookie=patient_cookie)
        other_status, _, _ = self.auth_request("GET", "/api/patients/P-1001", cookie=patient_cookie)
        self.assertEqual(own_status, 200)
        self.assertEqual(own_record["entries"], [])
        self.assertEqual(other_status, 403)

        _, _, clinician_cookie_header = self.auth_request("POST", "/api/auth/login", {"role": "clinician", "password": "clinician123"})
        clinician_cookie = clinician_cookie_header.split(";", 1)[0]
        _, patients, _ = self.auth_request("GET", "/api/patients", cookie=clinician_cookie)
        self.assertIn(new_id, {patient["id"] for patient in patients})

    def test_seeded_mr_chen_can_return_with_patient_id_and_age(self):
        status, payload, set_cookie = self.auth_request(
            "POST", "/api/auth/register-patient", {"patientId": "P-1001", "age": 68}
        )
        self.assertEqual(status, 201)
        self.assertEqual(payload["account"]["patientId"], "P-1001")
        cookie = set_cookie.split(";", 1)[0]
        record_status, record, _ = self.auth_request("GET", "/api/patients/P-1001", cookie=cookie)
        self.assertEqual(record_status, 200)
        self.assertEqual(record["patient"]["displayName"], "Mr Chen (synthetic)")

        wrong_status, _, _ = self.auth_request(
            "POST", "/api/auth/register-patient", {"patientId": "P-1001", "age": 67}
        )
        self.assertEqual(wrong_status, 403)

    def test_voice_transcription_is_role_scoped_and_does_not_store_audio(self):
        _, _, patient_cookie_header = self.auth_request(
            "POST", "/api/auth/register-patient", {"patientId": "P-1001", "age": 68}
        )
        patient_cookie = patient_cookie_header.split(";", 1)[0]
        status, payload, _ = self.auth_request(
            "POST",
            "/api/transcriptions",
            {"patientId": "P-1001", "mimeType": "audio/wav", "audioBase64": "UklGRg=="},
            cookie=patient_cookie,
        )
        self.assertEqual(status, 200)
        self.assertTrue(payload["transcript"])

        _, _, admin_cookie_header = self.auth_request(
            "POST", "/api/auth/login", {"role": "admin", "username": "clinic.ops", "password": "admin123"}
        )
        forbidden, _, _ = self.auth_request(
            "POST",
            "/api/transcriptions",
            {"patientId": "P-1001", "mimeType": "audio/wav", "audioBase64": "UklGRg=="},
            cookie=admin_cookie_header.split(";", 1)[0],
        )
        self.assertEqual(forbidden, 403)

        _, audit = self.request("GET", "/api/audit", role="admin")
        event = next(item for item in audit if item["action"] == "audio.transcribed")
        self.assertFalse(event["metadata"]["audioRetained"])
        self.assertNotIn("audioBase64", str(event))
