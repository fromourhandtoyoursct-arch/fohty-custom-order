/**
 * PII / secret redaction for logs.
 * Recursive; clones the input. Never mutates.
 */
const SECRET_KEY_PATTERN = /^(authorization|cookie|x[-_]square[-_]hmac.*|access[-_]?token|secret|password|cvv|cvc|card[-_]?number|pan|signature|api[-_]?key|hmac.*)$/i;
const EMAIL_RE = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@)([A-Za-z0-9.-])[A-Za-z0-9.-]*(\.[A-Za-z]{2,})/g;
const PHONE_RE = /(\+?\d[\d\s().-]{6,}\d)/g;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[max-depth]';
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

export function redactString(s: string): string {
  return s
    .replace(EMAIL_RE, (_m, l1, at, d1, tld) => `${l1}***${at}${d1}***${tld}`)
    .replace(PHONE_RE, (m) => {
      const digits = m.replace(/\D/g, '');
      if (digits.length < 7) return m;
      const last4 = digits.slice(-4);
      return `***-***-${last4}`;
    });
}

/** Safe-log: stringifies with redaction. */
export function safeLog(label: string, obj: unknown): void {
  try {
    console.log(label, JSON.stringify(redact(obj)));
  } catch {
    console.log(label, '[unserializable]');
  }
}
