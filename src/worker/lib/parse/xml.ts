import { coerceCell } from './delimited'

type XmlNode = {
  name: string
  attributes: Record<string, string>
  children: XmlNode[]
  text: string
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** Small non-validating XML reader: elements, attributes, text, CDATA. */
export function parseXml(input: string): unknown {
  const source = input.replace(/^\uFEFF/, '')
  let index = 0

  const fail = (message: string): never => {
    throw new SyntaxError(message)
  }

  const skipWhitespace = () => {
    while (index < source.length && /\s/.test(source[index]!)) index += 1
  }

  const readOpenTag = (): { node: XmlNode; selfClosing: boolean } => {
    skipWhitespace()
    if (source[index] !== '<') return fail('Expected "<"')
    index += 1
    const nameMatch = /^[^\s/>]+/.exec(source.slice(index))
    if (!nameMatch) return fail('Expected an element name')
    index += nameMatch[0].length
    const attributes: Record<string, string> = {}
    for (;;) {
      while (index < source.length && /\s/.test(source[index]!)) index += 1
      if (source[index] === '/' && source[index + 1] === '>') {
        index += 2
        return { node: { name: nameMatch[0], attributes, children: [], text: '' }, selfClosing: true }
      }
      if (source[index] === '>') {
        index += 1
        return { node: { name: nameMatch[0], attributes, children: [], text: '' }, selfClosing: false }
      }
      const attrMatch = /^([^\s=/>]+)\s*=\s*("[^"]*"|'[^']*')/.exec(source.slice(index))
      if (!attrMatch) return fail('Invalid attribute')
      const raw = attrMatch[2]!
      attributes[attrMatch[1]!] = decodeEntities(raw.slice(1, -1))
      index += attrMatch[0].length
    }
  }

  const readNode = (value: XmlNode) => {
    while (index < source.length) {
      const next = source.indexOf('<', index)
      if (next === -1) {
        value.text += decodeEntities(source.slice(index))
        index = source.length
        return
      }
      value.text += decodeEntities(source.slice(index, next))
      index = next

      if (source.startsWith('<!--', index)) {
        const end = source.indexOf('-->', index + 4)
        index = end === -1 ? source.length : end + 3
        continue
      }
      if (source.startsWith('<![CDATA[', index)) {
        const end = source.indexOf(']]>', index + 9)
        value.text += source.slice(index + 9, end === -1 ? source.length : end)
        index = end === -1 ? source.length : end + 3
        continue
      }
      if (source.startsWith('<?', index) || source.startsWith('<!', index)) {
        const end = source.indexOf('>', index)
        index = end === -1 ? source.length : end + 1
        continue
      }
      if (source.startsWith('</', index)) {
        const end = source.indexOf('>', index)
        index = end === -1 ? source.length : end + 1
        return
      }

      const child = readOpenTag()
      if (!child.selfClosing) readNode(child.node)
      value.children.push(child.node)
    }
  }

    if (source.indexOf('<') === -1) return fail('No XML element found')
  index = 0
  for (;;) {
    skipWhitespace()
    if (source.startsWith('<?', index) || source.startsWith('<!', index)) {
      const end = source.indexOf('>', index)
      if (end === -1) return fail('Unterminated declaration')
      index = end + 1
      continue
    }
    break
  }
  const root = readOpenTag()
  if (!root.selfClosing) readNode(root.node)
  return root.node
}

type Jsonish = null | boolean | number | string | Jsonish[] | { [key: string]: Jsonish }

/** Convert an XML element into the same value shapes the JSON reader produces. */
export function xmlToValue(node: XmlNode): Jsonish {
  const attributeEntries = Object.entries(node.attributes)
  const text = node.text.trim()

  if (!node.children.length) {
    // Typed leaves keep numbers and booleans intact when a file is rewritten
    // and read again, the same way delimited cells are read.
    if (!attributeEntries.length) return text ? (coerceCell(text) as Jsonish) : ''
    const out: Record<string, Jsonish> = {}
    for (const [key, value] of attributeEntries) out[`@${key}`] = value
    if (text) out['#text'] = text
    return out
  }

  const out: Record<string, Jsonish> = {}
  for (const [key, value] of attributeEntries) out[`@${key}`] = value
  const grouped = new Map<string, XmlNode[]>()
  for (const child of node.children)
    grouped.set(child.name, [...(grouped.get(child.name) ?? []), child])
  for (const [name, children] of grouped) {
    const values = children.map(xmlToValue)
    out[name] = values.length === 1 ? values[0]! : values
  }
  if (text) out['#text'] = text
  return out
}

export function parseXmlDocument(input: string): unknown {
  const root = parseXml(input) as XmlNode
  return { [root.name]: xmlToValue(root) }
}
