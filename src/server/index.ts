import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { createApp } from './app.js'

const { app, store } = createApp()
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const clientDist = path.resolve(__dirname, '../dist')
setInterval(() => store.processSecond(), 1_000)
setInterval(() => store.processAdds(), 10_000)
app.use(express.static(clientDist))
app.get('/{*path}', (req, res, next) => req.path.startsWith('/api/') ? next() : res.sendFile(path.join(clientDist, 'index.html')))
const port = Number(process.env.PORT ?? 3000)
app.listen(port, () => console.log(`Million IDs is running on http://localhost:${port}`))
