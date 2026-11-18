import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { AiError } from './lib/ai'
import { keysMatch, MUTATING_METHODS, presentedKey } from './lib/auth'
import { stats } from './lib/store'
import type { Env } from './lib/types'
import { registerExtraDocs } from './routes/extra-docs'
import { registerExtraRoutes } from './routes/extras'
import { registerFileRoutes } from './routes/files'
import { json } from './routes/shared'

const MAX_UPLOAD = 20 * 1024 * 1024
const MAX_BODY = 512 * 1024

const app = new OpenAPIHono<{ Bindings: Env }>({
  defaultHook: (result, c) => {
    if (!result.success)
      return c.json(
        {
          error: {
            code: 'invalid_input',
            message: 'Check the request fields and try again.',
          },
        },
        400,
      )
  },
})

const smallBody = bodyLimit({
  maxSize: MAX_BODY,
  onError: (c) =>
    c.json(
      { error: { code: 'body_too_large', message: 'Request body exceeds 512 KB.' } },
      413,
    ),
})

const uploadBody = bodyLimit({
  maxSize: MAX_UPLOAD,
  onError: (c) =>
    c.json(
      { error: { code: 'file_too_large', message: 'Files can be at most 20 MB.' } },
      413,
    ),
})

const isImport = (path: string) =>
  /^\/api\/files\/[^/]+\/collections\/[^/]+\/import$/.test(path)

/**
 * Every request that changes data needs the shared key. Reads stay open unless
 * CABINET_PROTECT_READS=true; with no key configured nothing can be changed at
 * all, so an accidentally exposed deployment is read-only rather than open.
 */
app.use('/api/*', async (c, next) => {
  const readsProtected = c.env?.CABINET_PROTECT_READS === 'true'
  const isRead = c.req.method === 'GET' || c.req.method === 'HEAD'
  const needsKey =
    MUTATING_METHODS.has(c.req.method) ||
    (readsProtected &&
      isRead &&
      c.req.path !== '/api/health' &&
      !c.req.path.startsWith('/api/share/'))
  if (!needsKey) return next()

  const expected = c.env?.CABINET_TOKEN?.trim()
  if (!expected)
    return c.json(
      {
        error: {
          code: 'auth_not_configured',
          message: 'Set CABINET_TOKEN on the server before changing data.',
        },
      },
      503,
    )
  const presented = presentedKey(c.req.raw)
  if (!presented || !(await keysMatch(presented, expected)))
    return c.json(
      {
        error: {
          code: 'unauthorized',
          message:
            'Send the access key as an Authorization: Bearer token or an x-cabinet-key header.',
        },
      },
      401,
    )
  return next()
})

/** Uploads and imports get the larger limit; every other API route stays small. */
app.use('/api/*', async (c, next) => {
  if (c.req.method === 'POST' && (c.req.path === '/api/files' || isImport(c.req.path)))
    return next()
  return smallBody(c, next)
})
app.use('/api/files/*', async (c, next) => {
  if (c.req.method === 'POST' && isImport(c.req.path)) return uploadBody(c, next)
  return next()
})
app.use('/api/files', uploadBody)

app.openapi(
  createRoute({
    method: 'get',
    path: '/api/health',
    summary: 'Check the service',
    responses: {
      200: {
        description: 'The service is running.',
        content: json(
          z.object({
            ok: z.boolean(),
            ai: z.boolean(),
            auth: z.boolean(),
            reads: z.boolean(),
            storage: z.object({ db: z.boolean(), files: z.boolean() }),
          }),
        ),
      },
    },
  }),
  (c) => {
    const env = c.env ?? ({} as Env)
    return c.json(
      {
        ok: true,
        ai: Boolean(env.OPENAI_API_KEY),
        auth: Boolean(env.CABINET_TOKEN),
        reads: env.CABINET_PROTECT_READS === 'true',
        storage: { db: Boolean(env.DB), files: Boolean(env.FILES) },
      },
      200,
    )
  },
)

app.openapi(
  createRoute({
    method: 'get',
    path: '/api/stats',
    summary: 'Count everything in the cabinet',
    responses: {
      200: {
        description: 'File, collection, record and event totals.',
        content: json(
          z.object({
            files: z.number(),
            trash: z.number(),
            collections: z.number(),
            records: z.number(),
            events: z.number(),
          }),
        ),
      },
    },
  }),
  async (c) => c.json(await stats(c.env.DB), 200),
)

registerFileRoutes(app)
registerExtraRoutes(app)
registerExtraDocs(app)

app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  description: 'The shared access key sent as an Authorization: Bearer token.',
})
app.openAPIRegistry.registerComponent('securitySchemes', 'cabinetKey', {
  type: 'apiKey',
  in: 'header',
  name: 'x-cabinet-key',
  description: 'The shared access key sent in its own header.',
})

app.doc('/openapi.json', {
  openapi: '3.0.0',
  info: {
    title: 'Cabinet',
    version: '1.0.0',
    description:
      'Open any data file, read the collections inside and edit every record. Mutating requests need the shared access key, sent as an Authorization: Bearer token or an x-cabinet-key header; a missing or wrong key is a 401, and a server without CABINET_TOKEN answers 503. Reads are open unless CABINET_PROTECT_READS=true, in which case they accept the same two forms and the same errors.',
  },
})

app.notFound((c) => {
  if (c.req.path === '/api' || c.req.path.startsWith('/api/'))
    return c.json({ error: { code: 'not_found', message: 'Endpoint not found.' } }, 404)
  return c.env.ASSETS.fetch(c.req.raw)
})

app.onError((error, c) => {
  if (error instanceof AiError)
    return c.json({ error: { code: error.code, message: error.message } }, 502)
  if (error instanceof HTTPException)
    return c.json(
      {
        error: {
          code: 'invalid_request',
          message: 'The request could not be processed.',
        },
      },
      error.status,
    )
  console.error('request failed', error)
  return c.json(
    { error: { code: 'internal_error', message: 'Something went wrong.' } },
    500,
  )
})

export default app
