import { parentPort } from 'node:worker_threads'
import { executeSearch, type SearchRequest } from './search.js'

const port = parentPort
if (!port) throw new Error('Search worker requires a parent port')

port.on('message', (request: SearchRequest) => {
  port.postMessage(executeSearch(request))
})
