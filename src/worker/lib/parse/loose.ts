/**
 * Tolerant reader for JavaScript-ish literals.
 *
 * Workers cannot evaluate code, so `.js`/`.dat` payloads holding an object or
 * array literal are read with this small recursive-descent parser instead.
 * It accepts single quotes, unquoted keys, trailing commas, comments and
 * hex numbers, which covers the shape of data modules and hand-written files.
 */
export function parseLoose(input: string): unknown {
  let index = 0
  const length = input.length

  const fail = (message: string): never => {
    throw new SyntaxError(message)
  }

  const skip = () => {
    while (index < length) {
      const char = input[index]
      if (char === ' ' || char === '\n' || char === '\r' || char === '\t') {
        index += 1
        continue
      }
      if (char === '/' && input[index + 1] === '/') {
        const end = input.indexOf('\n', index)
        index = end === -1 ? length : end + 1
        continue
      }
      if (char === '/' && input[index + 1] === '*') {
        const end = input.indexOf('*/', index + 2)
        index = end === -1 ? length : end + 2
        continue
      }
      break
    }
  }

  const parseString = (quote: string): string => {
    index += 1
    let out = ''
    while (index < length) {
      const char = input[index]
      if (char === '\\') {
        const next = input[index + 1]
        index += 2
        if (next === 'n') out += '\n'
        else if (next === 't') out += '\t'
        else if (next === 'r') out += '\r'
        else if (next === 'b') out += '\b'
        else if (next === 'f') out += '\f'
        else if (next === 'v') out += '\v'
        else if (next === '0') out += '\0'
        else if (next === 'u') {
          const hex = input.slice(index, index + 4)
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(Number.parseInt(hex, 16))
            index += 4
          } else out += 'u'
        } else if (next === 'x') {
          const hex = input.slice(index, index + 2)
          if (/^[0-9a-fA-F]{2}$/.test(hex)) {
            out += String.fromCharCode(Number.parseInt(hex, 16))
            index += 2
          } else out += 'x'
        } else if (next === undefined) fail('Unterminated escape')
        else out += next
        continue
      }
      if (char === quote) {
        index += 1
        return out
      }
      if (char === '\n' && quote !== '`') fail('Unterminated string')
      out += char
      index += 1
    }
    return fail('Unterminated string')
  }

  const parseNumber = (): number => {
    const rest = input.slice(index)
    const match =
      /^[+-]?(?:0[xX][0-9a-fA-F]+|0[bB][01]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/
        .exec(rest)
    if (!match) return fail('Invalid number')
    const raw = match[0]
    index += raw.length
    const sign = raw.startsWith('-') ? -1 : 1
    const body = raw.replace(/^[+-]/, '')
    if (/^0[xX]/.test(body)) return sign * Number.parseInt(body.slice(2), 16)
    if (/^0[bB]/.test(body)) return sign * Number.parseInt(body.slice(2), 2)
    const value = Number(body)
    return Number.isNaN(value) ? fail('Invalid number') : sign * value
  }

  const parseWord = (): unknown => {
    const rest = input.slice(index)
    const match = /^[A-Za-z_$][\w$]*/.exec(rest)
    if (!match) return fail('Unexpected character')
    const word = match[0]
    index += word.length
    if (word === 'true') return true
    if (word === 'false') return false
    if (word === 'null' || word === 'undefined') return null
    if (word === 'NaN' || word === 'Infinity') return null
    return fail(`Unexpected identifier "${word}"`)
  }

  const parseObject = (): Record<string, unknown> => {
    index += 1
    const out: Record<string, unknown> = {}
    skip()
    if (input[index] === '}') {
      index += 1
      return out
    }
    while (index < length) {
      skip()
      let key: string
      const char = input[index]
      if (char === '"' || char === "'" || char === '`') key = parseString(char)
      else {
        const rest = input.slice(index)
        const match = /^[^\s:{}[\],]+/.exec(rest)
        if (!match) return fail('Expected a field name')
        key = match[0]
        index += key.length
      }
      skip()
      if (input[index] !== ':') return fail('Expected ":"')
      index += 1
      out[key] = parseValue()
      skip()
      if (input[index] === ',') {
        index += 1
        skip()
        if (input[index] === '}') {
          index += 1
          return out
        }
        continue
      }
      if (input[index] === '}') {
        index += 1
        return out
      }
      return fail('Expected "," or "}"')
    }
    return fail('Unterminated object')
  }

  const parseArray = (): unknown[] => {
    index += 1
    const out: unknown[] = []
    skip()
    if (input[index] === ']') {
      index += 1
      return out
    }
    while (index < length) {
      out.push(parseValue())
      skip()
      if (input[index] === ',') {
        index += 1
        skip()
        if (input[index] === ']') {
          index += 1
          return out
        }
        continue
      }
      if (input[index] === ']') {
        index += 1
        return out
      }
      return fail('Expected "," or "]"')
    }
    return fail('Unterminated array')
  }

  const parseValue = (): unknown => {
    skip()
    const char = input[index]
    if (char === undefined) return fail('Unexpected end of input')
    if (char === '{') return parseObject()
    if (char === '[') return parseArray()
    if (char === '"' || char === "'" || char === '`') return parseString(char)
    if (char === '-' || char === '+' || char === '.' || (char >= '0' && char <= '9'))
      return parseNumber()
    return parseWord()
  }

  return parseValue()
}

/** Read the data value out of a module that exports one. */
export function parseScriptModule(text: string): unknown {
  const source = text.replace(/^\uFEFF/, '')
  const direct = tryParse(() => parseLoose(source))
  if (direct.ok) return direct.value

  const starts = [source.indexOf('{'), source.indexOf('[')]
    .filter((value) => value >= 0)
    .sort((a, b) => a - b)
  for (const start of starts) {
    const attempt = tryParse(() => parseLoose(source.slice(start)))
    if (attempt.ok) return attempt.value
  }
  throw new SyntaxError('No object or array literal found in the module')
}

function tryParse(run: () => unknown): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: run() }
  } catch {
    return { ok: false }
  }
}
