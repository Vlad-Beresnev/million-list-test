import { Worker } from 'node:worker_threads'
import type { SearchRequest, SearchResult } from './search.js'

export interface SearchRunner { search(request: SearchRequest): Promise<SearchResult> }

export class WorkerSearchRunner implements SearchRunner {
  private active = 0
  private readonly pending: Array<{ request: SearchRequest; resolve: (result: SearchResult) => void; reject: (error: Error) => void }> = []

  search(request: SearchRequest): Promise<SearchResult> {
    return new Promise((resolve, reject) => {
      this.pending.push({ request, resolve, reject })
      this.drain()
    })
  }

  private drain(): void {
    while (this.active < 2 && this.pending.length > 0) {
      const next = this.pending.shift()
      if (!next) return
      this.active += 1
      void this.runWorker(next.request).then(next.resolve, next.reject).finally(() => {
        this.active -= 1
        this.drain()
      })
    }
  }

  private runWorker(request: SearchRequest): Promise<SearchResult> {
    const isTypeScriptRuntime = import.meta.url.endsWith('.ts')
    const workerUrl = new URL(isTypeScriptRuntime ? './search-worker.ts' : './search-worker.js', import.meta.url)
    const worker = new Worker(workerUrl, isTypeScriptRuntime ? { execArgv: ['--import', 'tsx'] } : { execArgv: [] })
    return new Promise((resolve, reject) => {
      worker.once('message', (result: SearchResult) => { void worker.terminate(); resolve(result) })
      worker.once('error', (error) => { void worker.terminate(); reject(error) })
      worker.once('exit', (code) => { if (code !== 0) reject(new Error(`Search worker exited with code ${code}`)) })
      worker.postMessage(request)
    })
  }

}
