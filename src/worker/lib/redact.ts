/**
 * Values that should not reach a model provider. Cabinet still needs the shape
 * of the file, so matches are replaced with typed placeholders instead of
 * being dropped, and the number of redactions is reported back to the caller.
 */
const PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  {
    label: 'card',
    pattern: /\b(?:\d[ -]?){13,16}\b(?![0-9])/g,
  },
  { label: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  {
    label: 'phone',
    pattern: /(?:\+?\d{1,3}[ .-]?)?\(?\d{2,4}\)?[ .-]?\d{3,4}[ .-]?\d{3,4}\b/g,
  },
  { label: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    label: 'key',
    pattern: /\b(?:sk|pk|rk|ghp|gho|xox[bap])[-_][A-Za-z0-9_-]{16,}\b/g,
  },
  {
    label: 'secret',
    pattern: /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^\s"',;]{8,}/gi,
  },
]

export type Redaction = { text: string; count: number; kinds: string[] }

export function redactText(input: string): Redaction {
  let text = input
  let count = 0
  const kinds = new Set<string>()
  for (const { label, pattern } of PATTERNS) {
    text = text.replace(pattern, (match) => {
      // Plain short numbers are more likely data than card numbers.
      if (label === 'phone' && match.replace(/\D/g, '').length < 9) return match
      if (label === 'card' && match.replace(/\D/g, '').length < 13) return match
      count += 1
      kinds.add(label)
      return `[redacted-${label}]`
    })
  }
  return { text, count, kinds: [...kinds] }
}

/** Redaction can be switched off for a private, self-hosted model. */
export function redactForModel(text: string, enabled = true): Redaction {
  return enabled ? redactText(text) : { text, count: 0, kinds: [] }
}
