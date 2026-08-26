import json
import os
import shutil
import socket
import subprocess
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def mock_llm_analysis(message):
    lower = message.lower()
    if "fever" in lower or "cough" in lower or "flu" in lower:
        symptoms = [item for item in ("fever", "cough") if item in lower]
        hypotheses = ["influenza"] if "flu" in lower else []
        actions = ["paracetamol"] if "paracetamol" in lower else []
        return {
            "summary": f'Patient reports {" and ".join(symptoms)}. Patient suspects influenza. Patient reports self-management with paracetamol.',
            "plan": "Clinician review is recommended. Patient hypotheses are not treated as diagnoses.",
            "title": f'{" and ".join(symptoms).capitalize()}; patient suspects influenza',
            "riskReason": "unverified patient hypothesis and self-directed treatment",
            "category": "unverified_self_medication",
            "baseScore": 58,
            "concepts": {"symptoms": symptoms, "hypotheses": hypotheses, "actions": actions, "urgent": False, "recurrent": False},
            "suggestedTask": {"resultType": "respiratory_assessment", "title": "Arrange temperature and respiratory assessment", "rationale": "Objectively assess the reported fever or respiratory symptoms."},
            "sourceQuote": message,
        }
    if "chest" in lower or "difficulty breathing" in lower:
        return {
            "summary": "Patient reports chest tightness and difficulty breathing.",
            "plan": "Prompt clinician triage is recommended. AI has not made a diagnosis.",
            "title": "Chest tightness and difficulty breathing",
            "riskReason": "possible urgent symptom",
            "category": "urgent_patient_report",
            "baseScore": 90,
            "concepts": {"symptoms": ["chest tightness", "difficulty breathing"], "hypotheses": [], "actions": [], "urgent": True, "recurrent": False},
            "suggestedTask": {"resultType": "urgent_assessment", "title": "Arrange urgent clinical assessment", "rationale": "Promptly assess the reported red-flag symptoms."},
            "sourceQuote": "My chest feels tight and I have difficulty breathing.",
        }
    if "headache" in lower or "migraine" in lower:
        return {
            "summary": "Patient reports headache. Patient suspects migraine.",
            "plan": "Clinician review is recommended. Patient hypotheses are not treated as diagnoses.",
            "title": "Headache; patient suspects migraine",
            "riskReason": "unverified patient hypothesis and recurrent symptom",
            "category": "unverified_patient_hypothesis",
            "baseScore": 55,
            "concepts": {"symptoms": ["headache"], "hypotheses": ["migraine"], "actions": [], "urgent": False, "recurrent": True},
            "suggestedTask": {"resultType": "neurological_assessment", "title": "Arrange clinician headache assessment", "rationale": "Review the recurrent headache and screen for warning signs."},
            "sourceQuote": message,
        }
    if "dizz" in lower or "low blood sugar" in lower or "glucose" in lower:
        return {
            "summary": "Patient reports dizziness. Patient suspects low blood sugar. Patient reports self-management with glucose.",
            "plan": "Clinician review is recommended. Patient hypotheses are not treated as diagnoses.",
            "title": "Dizziness; patient suspects low blood sugar",
            "riskReason": "unverified patient hypothesis and self-directed treatment",
            "category": "unverified_self_medication",
            "baseScore": 58,
            "concepts": {"symptoms": ["dizziness"], "hypotheses": ["low blood sugar"], "actions": ["glucose"], "urgent": False, "recurrent": "sometimes" in lower},
            "suggestedTask": {"resultType": "glucose_panel", "title": "Arrange fasting glucose and HbA1c tests", "rationale": "Objectively evaluate the patient-reported blood-sugar hypothesis."},
            "sourceQuote": message,
        }
    return {
        "summary": f'Patient reports a new concern: “{message}”',
        "plan": "Clinician review is recommended. AI has not made a diagnosis.",
        "title": "New patient-reported concern",
        "riskReason": "new patient report",
        "category": "patient_reported_concern",
        "baseScore": 35,
        "concepts": {"symptoms": [], "hypotheses": [], "actions": [], "urgent": False, "recurrent": False},
        "suggestedTask": {"resultType": "general_assessment", "title": "Arrange clinician assessment", "rationale": "Review the new patient-reported concern without assuming a diagnosis."},
        "sourceQuote": message,
    }


class MockLlmHandler(BaseHTTPRequestHandler):
    requests = []

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        request_body = json.loads(self.rfile.read(length) or b"{}")
        type(self).requests.append(request_body)
        message = request_body.get("input", "").split("\n", 1)[-1]
        format_name = request_body.get("text", {}).get("format", {}).get("name")
        if format_name == "patient_message_analysis":
            output = mock_llm_analysis(message)
        elif format_name == "conversation_timeline_summary":
            output = {
                "title": "Conversation update awaiting review",
                "summary": "The conversation records patient concerns and care-team follow-up without confirming unverified claims.",
                "plan": "Clinician review and next-step confirmation are required.",
            }
        else:
            output = "Thank you for sharing that. Could you tell me when this started? A clinician will review this conversation."
        response_body = json.dumps({
            "model": "test-external-llm",
            "output": [{"type": "message", "content": [{"type": "output_text", "text": json.dumps(output) if isinstance(output, dict) else output}]}],
        }).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(response_body)))
        self.end_headers()
        self.wfile.write(response_body)

    def log_message(self, format, *args):
        return


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class ApiTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = free_port()
        cls.llm_port = free_port()
        cls.llm_server = ThreadingHTTPServer(("127.0.0.1", cls.llm_port), MockLlmHandler)
        import threading
        cls.llm_thread = threading.Thread(target=cls.llm_server.serve_forever, daemon=True)
        cls.llm_thread.start()
        node = os.environ.get("NIGHTINGALE_NODE") or shutil.which("node")
        if not node:
            raise RuntimeError("Node.js is required. Set NIGHTINGALE_NODE to its executable path.")
        server_env = os.environ.copy()
        server_env.update({
            "OPENAI_API_KEY": "test-key",
            "OPENAI_MODEL": "test-external-llm",
            "OPENAI_BASE_URL": f"http://127.0.0.1:{cls.llm_port}/v1",
        })
        cls.process = subprocess.Popen(
            [node, "server.js", "--demo", f"--port={cls.port}"],
            cwd=ROOT,
            env=server_env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        deadline = time.time() + 8
        while time.time() < deadline:
            try:
                cls.request("GET", "/api/health", role=None)
                return
            except Exception:
                time.sleep(0.1)
        cls.process.terminate()
        raise RuntimeError("Test server did not start")

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        try:
            cls.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            cls.process.kill()
        cls.llm_server.shutdown()
        cls.llm_server.server_close()

    def setUp(self):
        self.request("POST", "/api/test/reset", role=None)

    @classmethod
    def request(cls, method, path, role="clinician", body=None, clinic="clinic-sg-01"):
        headers = {"Content-Type": "application/json"}
        if role:
            headers.update(
                {
                    "x-role": role,
                    "x-user-id": f"{role}-test",
                    "x-clinic-id": clinic,
                }
            )
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(
            f"http://127.0.0.1:{cls.port}{path}",
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                return response.status, json.loads(response.read() or b"{}")
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read() or b"{}")
