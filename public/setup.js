const form = document.querySelector("#llm-setup-form");
const status = document.querySelector("#setup-status");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  status.textContent = "Connecting…";
  const body = Object.fromEntries(new FormData(form));
  body.persist = body.persist === "true";
  const response = await fetch("/api/demo/configure-llm", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-local-setup": "threadcare-demo"
    },
    body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) {
    status.textContent = result.error || "Could not connect Gemini.";
    return;
  }
  form.reset();
  status.textContent = `Connected and saved: ${result.provider} · ${result.model}`;
});
