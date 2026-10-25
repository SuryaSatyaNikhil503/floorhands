// Redaction for everything floorhands writes to disk or hands from one agent to the next: step output, events, the raw plan and the
// patches it keeps for rejected or failed tasks. Agents can read committed secrets (known limit), so their output can quote one;
// this keeps such a value out of .floorhands/ and out of later agents' prompts. It is a pattern list, so it is a safety net and not a
// guarantee: the finding ("hardcoded secret at path:line") survives, the value does not.
const RULES = [
  // PEM private key blocks, whole.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED private key]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED aws key id]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g, '[REDACTED github token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, '[REDACTED github token]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED gitlab token]'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, '[REDACTED anthropic key]'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g, '[REDACTED api key]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[REDACTED slack token]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED google key]'],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, '[REDACTED npm token]'],
  [/\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g, '[REDACTED stripe key]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED jwt]'],
  // Credentials inside a URL: scheme://user:password@host keeps the user and host.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]{3,}@/gi, '$1[REDACTED]@'],
  // A quoted literal assigned to a secret-looking name. Unquoted right-hand sides (req.body.password) are code, not secrets, and stay.
  [/\b([A-Za-z0-9_]*(?:secret|passw(?:or)?d|passwd|token|api[_-]?key|private[_-]?key)[A-Za-z0-9_]*["']?\s*[:=]\s*)(["'`])[^"'`\s]{8,}\2/gi, '$1$2[REDACTED]$2'],
];

export function redact(text) {
  if (typeof text !== 'string' || text === '') return text;
  let out = text;
  for (const [re, sub] of RULES) out = out.replace(re, sub);
  return out;
}
