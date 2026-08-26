const baseUrl = (process.env.BENCHMARK_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const warmups = Number(process.env.BENCHMARK_WARMUPS || 20);
const sampleCount = Number(process.env.BENCHMARK_SAMPLES || 200);
const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ role: "clinician", password: process.env.CLINICIAN_PASSWORD || "clinician123" })
});
if (!loginResponse.ok) throw new Error(`Benchmark login returned HTTP ${loginResponse.status}`);
const cookie = loginResponse.headers.get("set-cookie")?.split(";", 1)[0];
const headers = { cookie };

async function loadConsultGlance() {
  const startedAt = performance.now();
  for (const path of ["/api/patients/P-1001", "/api/conversations?patientId=P-1001"]) {
    const response = await fetch(`${baseUrl}${path}`, { headers });
    if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
    await response.arrayBuffer();
  }
  return performance.now() - startedAt;
}

for (let index = 0; index < warmups; index += 1) await loadConsultGlance();

const samplesMs = [];
for (let index = 0; index < sampleCount; index += 1) samplesMs.push(await loadConsultGlance());
samplesMs.sort((a, b) => a - b);

const percentile = (value) => samplesMs[Math.max(0, Math.ceil(samplesMs.length * value) - 1)];
const result = {
  measuredAt: new Date().toISOString(),
  target: "warm consult glance API path",
  method: "Sequential GET patient care-note data plus visible conversations, matching the browser load path",
  environment: "localhost; synthetic server-persisted demo state; authenticated session",
  warmups,
  samples: sampleCount,
  medianMs: Number(percentile(0.5).toFixed(2)),
  p95Ms: Number(percentile(0.95).toFixed(2)),
  p99Ms: Number(percentile(0.99).toFixed(2)),
  requirementMs: 300,
  passes: percentile(0.95) <= 300
};

console.log(JSON.stringify(result, null, 2));
if (!result.passes) process.exitCode = 1;
