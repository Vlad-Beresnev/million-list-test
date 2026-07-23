import { BUILT_IN_MAX_ID, type SearchRequest, type SearchResult } from './search.js'
import { WorkerSearchRunner, type SearchRunner } from './search-runner.js'

export { BUILT_IN_MAX_ID }
export type Pane = 'available' | 'selected'
export type SelectionAction = 'select' | 'deselect'
export type Change =
  | { type: 'selection'; id: string; action: SelectionAction }
  | { type: 'move'; id: string; beforeId: string | null }

export interface ItemPage { items: string[]; nextCursor: string | null; hasMore: boolean; revision: number; reset?: boolean }
export interface Revision { revision: number }

type ReadRequest = { pane: Pane; filter: string; cursor: string | null; limit: number }
type Deferred<T> = { resolve: (value: T) => void; reject: (error: Error) => void }
type QueuedRead =
  | { type: 'page'; request: ReadRequest; waiters: Deferred<ItemPage>[] }
  | { type: 'revision'; waiters: Deferred<Revision>[] }
type SearchCursor = { kind: 'search'; source: 'builtIn' | 'selected'; start: number; revision: number }
type CachedSearch = { lastUsed: number; promise: Promise<ItemPage> }
type CompletedFilteredRead = { waiters: Deferred<ItemPage>[]; page?: ItemPage; error?: Error }

const builtInId = (id: string) => /^(?:[1-9]\d*)$/.test(id) && Number(id) <= BUILT_IN_MAX_ID
const readKey = (request: ReadRequest) => JSON.stringify(request)
const encodeCursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const decodeCursor = <T>(cursor: string | null): T | null => {
  if (!cursor) return null
  try { return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as T } catch { return null }
}
const isSearchCursor = (value: unknown): value is SearchCursor => Boolean(value && typeof value === 'object' && 'kind' in value && (value as SearchCursor).kind === 'search')

export class InMemoryStore {
  private readonly customIds = new Set<string>()
  private selectedIds: string[] = []
  private revision = 0

  private readonly selectionQueue = new Map<string, SelectionAction>()
  private readonly moveQueue = new Map<string, string | null>()
  private readonly changeWaiters: Deferred<Revision>[] = []
  private readonly addQueue = new Set<string>()
  private readonly addWaiters: Array<{ ids: string[]; deferred: Deferred<{ added: string[] }> }> = []
  private readonly readQueue = new Map<string, QueuedRead>()
  private readonly filteredPageCache = new Map<string, CachedSearch>()
  private readonly completedFilteredReads: CompletedFilteredRead[] = []

  constructor(private readonly searchRunner: SearchRunner = new WorkerSearchRunner()) {}

  enqueueRead(request: ReadRequest): Promise<ItemPage> {
    const normalized = { ...request, filter: request.filter.trim(), limit: Math.min(Math.max(request.limit, 1), 20) }
    const key = readKey(normalized)
    return new Promise((resolve, reject) => {
      const queued = this.readQueue.get(key)
      if (queued?.type === 'page') queued.waiters.push({ resolve, reject })
      else this.readQueue.set(key, { type: 'page', request: normalized, waiters: [{ resolve, reject }] })
    })
  }

  enqueueRevision(): Promise<Revision> {
    return new Promise((resolve, reject) => {
      const queued = this.readQueue.get('revision')
      if (queued?.type === 'revision') queued.waiters.push({ resolve, reject })
      else this.readQueue.set('revision', { type: 'revision', waiters: [{ resolve, reject }] })
    })
  }

  enqueueChanges(changes: Change[]): Promise<Revision> {
    for (const change of changes) {
      if (change.type === 'selection' && this.isKnown(change.id)) this.selectionQueue.set(change.id, change.action)
      if (change.type === 'move' && this.isKnown(change.id) && (change.beforeId === null || this.isKnown(change.beforeId))) this.moveQueue.set(change.id, change.beforeId)
    }
    return new Promise((resolve, reject) => this.changeWaiters.push({ resolve, reject }))
  }

  queueAdd(rawIds: string[]): { queued: string[]; completion: Promise<{ added: string[] }> } {
    const unique = [...new Set(rawIds.map((id) => id.trim()).filter(Boolean))]
    const accepted = unique.filter((id) => !builtInId(id) && !this.customIds.has(id) && !this.addQueue.has(id))
    const completion = new Promise<{ added: string[] }>((resolve, reject) => {
      if (accepted.length === 0) { resolve({ added: [] }); return }
      for (const id of accepted) this.addQueue.add(id)
      this.addWaiters.push({ ids: accepted, deferred: { resolve, reject } })
    })
    return { queued: accepted, completion }
  }

  enqueueAdd(rawIds: string[]): Promise<{ added: string[] }> {
    return this.queueAdd(rawIds).completion
  }

  processSecond(): void {
    for (const completed of this.completedFilteredReads.splice(0)) {
      for (const waiter of completed.waiters) {
        if (completed.error) waiter.reject(completed.error)
        else if (completed.page) waiter.resolve(completed.page)
      }
    }
    const changeCount = this.selectionQueue.size + this.moveQueue.size
    const readCount = this.readQueue.size
    this.applyChanges()
    const revision = { revision: this.revision }
    for (const waiter of this.changeWaiters.splice(0)) waiter.resolve(revision)
    for (const queued of this.readQueue.values()) {
      if (queued.type === 'revision') {
        for (const waiter of queued.waiters) waiter.resolve(revision)
      } else if (queued.request.filter) {
        void this.filteredPage(queued.request).then(
          (page) => this.completedFilteredReads.push({ waiters: queued.waiters, page }),
          (error: Error) => this.completedFilteredReads.push({ waiters: queued.waiters, error }),
        )
      } else {
        const page = this.getPage(queued.request)
        for (const waiter of queued.waiters) waiter.resolve(page)
      }
    }
    this.readQueue.clear()
    if (changeCount || readCount) console.info(`[queue:1s] processed ${changeCount} change(s), ${readCount} read job(s), revision ${this.revision}`)
  }

  processAdds(): void {
    const addCount = this.addQueue.size
    let changed = false
    for (const id of this.addQueue) {
      if (!this.customIds.has(id)) { this.customIds.add(id); changed = true }
    }
    this.addQueue.clear()
    for (const { ids, deferred } of this.addWaiters.splice(0)) deferred.resolve({ added: ids })
    if (changed) { this.revision += 1; this.invalidateFilteredPages() }
    if (addCount) console.info(`[queue:10s] added ${addCount} unique ID(s), revision ${this.revision}`)
  }

  private applyChanges(): void {
    let changed = false
    for (const [id, action] of this.selectionQueue) {
      const index = this.selectedIds.indexOf(id)
      if (action === 'select' && index === -1) { this.selectedIds.push(id); changed = true }
      if (action === 'deselect' && index !== -1) { this.selectedIds.splice(index, 1); changed = true }
    }
    this.selectionQueue.clear()
    for (const [id, beforeId] of this.moveQueue) {
      const from = this.selectedIds.indexOf(id)
      if (from === -1) continue
      this.selectedIds.splice(from, 1)
      const target = beforeId === null ? -1 : this.selectedIds.indexOf(beforeId)
      if (target === -1) this.selectedIds.push(id)
      else this.selectedIds.splice(target, 0, id)
      changed = true
    }
    this.moveQueue.clear()
    if (changed) { this.revision += 1; this.invalidateFilteredPages() }
  }

  private getPage(request: ReadRequest): ItemPage {
    return request.pane === 'selected' ? this.selectedPage(request) : this.availablePage(request)
  }

  private filteredPage(request: ReadRequest): Promise<ItemPage> {
    this.pruneFilteredPages()
    const sourceRevision = this.revision
    const requestedCursor = decodeCursor<SearchCursor>(request.cursor)
    if (isSearchCursor(requestedCursor) && requestedCursor.revision !== sourceRevision) {
      return Promise.resolve({ items: [], nextCursor: null, hasMore: false, revision: sourceRevision, reset: true })
    }
    const key = JSON.stringify({ ...request, revision: sourceRevision })
    const cached = this.filteredPageCache.get(key)
    if (cached) { cached.lastUsed = Date.now(); return cached.promise }
    const promise = (request.pane === 'available' ? this.filteredAvailablePage(request, sourceRevision) : this.filteredSelectedPage(request, sourceRevision))
      .then((page) => sourceRevision === this.revision ? page : { ...page, items: [], nextCursor: null, hasMore: false, revision: this.revision, reset: true })
    this.filteredPageCache.set(key, { lastUsed: Date.now(), promise })
    return promise
  }

  private async filteredSelectedPage({ filter, cursor, limit }: ReadRequest, sourceRevision: number): Promise<ItemPage> {
    const decoded = decodeCursor<SearchCursor>(cursor)
    const start = decoded?.kind === 'search' && decoded.source === 'selected' && decoded.revision === sourceRevision ? decoded.start : 0
    const result = await this.searchRunner.search({ type: 'selected', filter, start, limit, ids: this.selectedIds })
    return this.searchPage(result, 'selected', sourceRevision)
  }

  private async filteredAvailablePage({ filter, cursor, limit }: ReadRequest, sourceRevision: number): Promise<ItemPage> {
    const selected = new Set(this.selectedIds)
    const decoded = decodeCursor<SearchCursor | { section: 'custom' | 'builtIn'; after: number | string }>(cursor)
    const custom = [...this.customIds].reverse()
    let customIndex = decoded && 'section' in decoded && decoded.section === 'custom' ? custom.indexOf(String(decoded.after)) + 1 : decoded && 'section' in decoded && decoded.section === 'builtIn' ? custom.length : 0
    if (customIndex <= 0 && decoded && 'section' in decoded && decoded.section === 'custom') customIndex = custom.length
    const items: string[] = []
    while (items.length < limit && customIndex < custom.length) {
      const id = custom[customIndex++]
      if (!selected.has(id) && id.includes(filter)) items.push(id)
    }
    if (customIndex < custom.length) {
      return { items, nextCursor: encodeCursor({ section: 'custom', after: custom[customIndex - 1] }), hasMore: true, revision: sourceRevision }
    }
    const start = isSearchCursor(decoded) && decoded.source === 'builtIn' && decoded.revision === sourceRevision ? decoded.start : decoded && 'section' in decoded && decoded.section === 'builtIn' ? Number(decoded.after) + 1 : 1
    const result = await this.searchRunner.search({ type: 'builtIn', filter, start, limit: Math.max(1, limit - items.length), excludedIds: this.selectedIds })
    if (items.length === limit && result.items.length > 0) return { items, nextCursor: encodeCursor({ kind: 'search', source: 'builtIn', start, revision: sourceRevision }), hasMore: true, revision: sourceRevision }
    return this.searchPage({ ...result, items: [...items, ...result.items] }, 'builtIn', sourceRevision)
  }

  private searchPage(result: SearchResult, source: SearchCursor['source'], sourceRevision: number): ItemPage {
    return {
      items: result.items,
      nextCursor: result.hasMore ? encodeCursor({ kind: 'search', source, start: result.nextStart, revision: sourceRevision }) : null,
      hasMore: result.hasMore,
      revision: sourceRevision,
    }
  }

  private invalidateFilteredPages(): void {
    this.filteredPageCache.clear()
  }

  private pruneFilteredPages(): void {
    const now = Date.now()
    for (const [key, cached] of this.filteredPageCache) if (now - cached.lastUsed > 60_000) this.filteredPageCache.delete(key)
    while (this.filteredPageCache.size >= 8) {
      const oldest = [...this.filteredPageCache.entries()].sort(([, left], [, right]) => left.lastUsed - right.lastUsed)[0]
      if (!oldest) break
      this.filteredPageCache.delete(oldest[0])
    }
  }

  private selectedPage({ filter, cursor, limit }: ReadRequest): ItemPage {
    const decoded = decodeCursor<{ offset: number }>(cursor)
    const offset = decoded?.offset ?? 0
    const matches = this.selectedIds.filter((id) => id.includes(filter))
    const items = matches.slice(offset, offset + limit)
    const nextOffset = offset + items.length
    return { items, nextCursor: nextOffset < matches.length ? encodeCursor({ offset: nextOffset }) : null, hasMore: nextOffset < matches.length, revision: this.revision }
  }

  private availablePage({ filter, cursor, limit }: ReadRequest): ItemPage {
    const selected = new Set(this.selectedIds)
    const decoded = decodeCursor<{ section: 'builtIn' | 'custom'; after: number | string }>(cursor)
    const items: string[] = []
    const custom = [...this.customIds].reverse()
    let customIndex = decoded?.section === 'custom' ? custom.indexOf(String(decoded.after)) + 1 : decoded?.section === 'builtIn' ? custom.length : 0
    if (customIndex <= 0 && decoded?.section === 'custom') customIndex = custom.length
    let builtIn = decoded?.section === 'builtIn' ? Number(decoded.after) + 1 : 1

    while (items.length < limit && customIndex < custom.length) {
      const id = custom[customIndex++]
      if (!selected.has(id) && id.includes(filter)) items.push(id)
    }
    while (items.length < limit && builtIn <= BUILT_IN_MAX_ID) {
      const id = String(builtIn++)
      if (!selected.has(id) && id.includes(filter)) items.push(id)
    }
    const hasMore = builtIn <= BUILT_IN_MAX_ID || customIndex < custom.length
    const nextCursor = hasMore
      ? customIndex < custom.length ? encodeCursor({ section: 'custom', after: custom[customIndex - 1] }) : encodeCursor({ section: 'builtIn', after: builtIn - 1 })
      : null
    return { items, nextCursor, hasMore, revision: this.revision }
  }

  private isKnown(id: string): boolean { return builtInId(id) || this.customIds.has(id) }
}
