const PHONE_PATTERN = /(?<!\d)(?:\+?\d[\d\s-]{7,}\d)(?!\d)/g;
const ID_PATTERN = /\b(?:[A-Z]\d{7}[A-Z]|[STFG]\d{7}[A-Z]|\d{6}-\d{2}-\d{4})\b/gi;

export function redactPhi(text, knownNames = []) {
  let redacted = String(text || "")
    .replace(PHONE_PATTERN, "[REDACTED_PHONE]")
    .replace(ID_PATTERN, "[REDACTED_ID]");

  for (const name of knownNames.filter(Boolean).sort((a, b) => b.length - a.length)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    redacted = redacted.replace(new RegExp(`\\b${escaped}\\b`, "gi"), "[REDACTED_NAME]");
  }
  return redacted;
}
