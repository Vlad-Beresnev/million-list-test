import express from 'express'
import { InMemoryStore, type Change, type Pane } from './store.js'

const isId = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

export function createApp(store = new InMemoryStore()) {
  const app = express()
  app.use(express.json())
  app.get('/api/revision', async (_req, res, next) => { try { res.json(await store.enqueueRevision()) } catch (error) { next(error) } })
  app.get('/api/items', async (req, res, next) => {
    const pane = req.query.pane === 'selected' ? 'selected' : req.query.pane === 'available' ? 'available' : null
    if (!pane) return res.status(400).json({ error: 'pane must be available or selected' })
    try {
      const filter = typeof req.query.filter === 'string' ? req.query.filter : ''
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null
      const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 20
      return res.json(await store.enqueueRead({ pane: pane as Pane, filter, cursor, limit }))
    } catch (error) { return next(error) }
  })
  app.post('/api/changes', async (req, res, next) => {
    const raw = Array.isArray(req.body?.changes) ? req.body.changes : []
    const changes: Change[] = raw.flatMap((change: unknown) => {
      if (!change || typeof change !== 'object') return []
      const value = change as Record<string, unknown>
      if (value.type === 'selection' && isId(value.id) && (value.action === 'select' || value.action === 'deselect')) return [{ type: 'selection' as const, id: value.id.trim(), action: value.action }]
      if (value.type === 'move' && isId(value.id) && (value.beforeId === null || isId(value.beforeId))) return [{ type: 'move' as const, id: value.id.trim(), beforeId: value.beforeId === null ? null : value.beforeId.trim() }]
      return []
    })
    try { return res.json(await store.enqueueChanges(changes)) } catch (error) { return next(error) }
  })
  app.post('/api/ids', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(isId) : []
    const { queued } = store.queueAdd(ids)
    return res.status(202).json({ queued })
  })
  return { app, store }
}
