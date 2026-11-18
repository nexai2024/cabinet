/** Shared-key guard for every request that changes data. */

export const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** The key travels either as a bearer token or in its own header. */
export function presentedKey(request: Request): string {
  const authorization = request.headers.get('authorization') ?? ''
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization.trim())
  if (bearer) return bearer[1]!.trim()
  return (request.headers.get('x-cabinet-key') ?? '').trim()
}

/** Compare digests so a wrong key cannot be narrowed down by timing. */
export async function keysMatch(presented: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(presented)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ])
  const a = new Uint8Array(left)
  const b = new Uint8Array(right)
  let difference = 0
  for (let index = 0; index < a.length; index += 1) difference |= a[index]! ^ b[index]!
  return difference === 0
}
