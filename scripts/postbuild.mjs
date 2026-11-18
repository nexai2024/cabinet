// Remove build metadata and source maps from the public deployment output.
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

function clean(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.name.startsWith('.') || entry.name.endsWith('.map'))
      rmSync(path, { recursive: true, force: true })
    else if (entry.isDirectory()) clean(path)
  }
}

clean(new URL('../dist', import.meta.url).pathname)
