import { describe, expect, it, vi } from 'vitest'
import { executeSearch, type SearchRequest } from './search.js'
import type { SearchRunner } from './search-runner.js'
import { InMemoryStore } from './store.js'

const directSearchRunner = (): SearchRunner => ({ search: async (request: SearchRequest) => executeSearch(request) })
const releaseFilteredRead = async (store: InMemoryStore) => { await new Promise<void>((resolve) => setImmediate(resolve)); store.processSecond() }

describe('InMemoryStore', () => {
  it('deduplicates an arbitrary custom ID and batches it only on the add tick', async () => {
    const store = new InMemoryStore()
    const first = store.enqueueAdd(['customer-42'])
    const second = store.enqueueAdd(['customer-42'])
    await expect(second).resolves.toEqual({ added: [] })
    store.processAdds()
    await expect(first).resolves.toEqual({ added: ['customer-42'] })
  })

  it('deduplicates concurrent revision polls into one queued read', async () => {
    const store = new InMemoryStore()
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const first = store.enqueueRevision()
    const second = store.enqueueRevision()
    store.processSecond()
    await expect(Promise.all([first, second])).resolves.toEqual([{ revision: 0 }, { revision: 0 }])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('1 read job(s)'))
    log.mockRestore()
  })

  it('shows manually added IDs first, newest first, before built-in IDs', async () => {
    const store = new InMemoryStore()
    const add = store.enqueueAdd(['customer-42', 'another-id'])
    store.processAdds()
    await add
    const page = store.enqueueRead({ pane: 'available', filter: '', cursor: null, limit: 20 })
    store.processSecond()
    const result = await page
    expect(result.items).toHaveLength(20)
    expect(result.items.slice(0, 5)).toEqual(['another-id', 'customer-42', '1', '2', '3'])
    expect(result.hasMore).toBe(true)
  })

  it('returns a no-match available filter without blocking the queued read result', async () => {
    const store = new InMemoryStore(directSearchRunner())
    const page = store.enqueueRead({ pane: 'available', filter: 'no-such-id', cursor: null, limit: 20 })
    store.processSecond()
    await releaseFilteredRead(store)
    await expect(page).resolves.toMatchObject({ items: [], hasMore: false })
  })

  it('paginates filtered selected IDs in server order', async () => {
    const store = new InMemoryStore(directSearchRunner())
    const changes = Array.from({ length: 25 }, (_, index) => ({ type: 'selection' as const, id: String(index + 101), action: 'select' as const }))
    store.enqueueChanges(changes); store.processSecond()
    const first = store.enqueueRead({ pane: 'selected', filter: '1', cursor: null, limit: 20 }); store.processSecond()
    await releaseFilteredRead(store)
    const firstPage = await first
    expect(firstPage.items).toHaveLength(20)
    expect(firstPage.nextCursor).not.toBeNull()
    const second = store.enqueueRead({ pane: 'selected', filter: '1', cursor: firstPage.nextCursor, limit: 20 }); store.processSecond()
    await releaseFilteredRead(store)
    await expect(second).resolves.toMatchObject({ items: ['121', '122', '123', '124', '125'], hasMore: false })
  })

  it('deduplicates concurrent filtered page reads', async () => {
    let calls = 0
    const runner: SearchRunner = { search: async (request) => { calls += 1; return executeSearch(request) } }
    const store = new InMemoryStore(runner)
    const request = { pane: 'available' as const, filter: '999', cursor: null, limit: 20 }
    const first = store.enqueueRead(request)
    const second = store.enqueueRead(request)
    store.processSecond()
    await releaseFilteredRead(store)
    await Promise.all([first, second])
    expect(calls).toBe(1)
  })

  it('paginates a sparse available filter without duplicate IDs', async () => {
    const store = new InMemoryStore(directSearchRunner())
    const first = store.enqueueRead({ pane: 'available', filter: '999', cursor: null, limit: 20 }); store.processSecond()
    await releaseFilteredRead(store)
    const firstPage = await first
    expect(firstPage.items).toHaveLength(20)
    expect(firstPage.nextCursor).not.toBeNull()
    const second = store.enqueueRead({ pane: 'available', filter: '999', cursor: firstPage.nextCursor, limit: 20 }); store.processSecond()
    await releaseFilteredRead(store)
    const secondPage = await second
    expect(secondPage.items).toHaveLength(20)
    expect(new Set([...firstPage.items, ...secondPage.items])).toHaveLength(40)
  })

  it('invalidates a filtered available page after a selection revision', async () => {
    const store = new InMemoryStore(directSearchRunner())
    const first = store.enqueueRead({ pane: 'available', filter: '1', cursor: null, limit: 20 }); store.processSecond()
    await releaseFilteredRead(store)
    const firstPage = await first
    const selectedId = firstPage.items[0]
    store.enqueueChanges([{ type: 'selection', id: selectedId, action: 'select' }]); store.processSecond()
    const refreshed = store.enqueueRead({ pane: 'available', filter: '1', cursor: firstPage.nextCursor, limit: 20 }); store.processSecond()
    await releaseFilteredRead(store)
    const refreshedPage = await refreshed
    expect(refreshedPage.revision).toBe(1)
    expect(refreshedPage.reset).toBe(true)
    const restarted = store.enqueueRead({ pane: 'available', filter: '1', cursor: null, limit: 20 }); store.processSecond()
    await releaseFilteredRead(store)
    await expect(restarted).resolves.not.toMatchObject({ items: expect.arrayContaining([selectedId]) })
  })

  it('uses the final selection intent for each ID in a one-second batch', async () => {
    const store = new InMemoryStore()
    const pending = store.enqueueChanges([{ type: 'selection', id: '42', action: 'select' }, { type: 'selection', id: '42', action: 'deselect' }])
    store.processSecond()
    await expect(pending).resolves.toEqual({ revision: 0 })
    const page = store.enqueueRead({ pane: 'selected', filter: '', cursor: null, limit: 20 })
    store.processSecond()
    await expect(page).resolves.toMatchObject({ items: [] })
  })

  it('returns no more than 20 selected IDs per page', async () => {
    const store = new InMemoryStore()
    const changes = Array.from({ length: 25 }, (_, index) => ({ type: 'selection' as const, id: String(index + 1), action: 'select' as const }))
    store.enqueueChanges(changes); store.processSecond()
    const first = store.enqueueRead({ pane: 'selected', filter: '', cursor: null, limit: 20 }); store.processSecond()
    const page = await first
    expect(page.items).toHaveLength(20)
    expect(page.nextCursor).not.toBeNull()
  })

  it('moves a selected ID before another selected ID', async () => {
    const store = new InMemoryStore()
    store.enqueueChanges(['1', '2', '3'].map((id) => ({ type: 'selection' as const, id, action: 'select' as const }))); store.processSecond()
    store.enqueueChanges([{ type: 'move', id: '3', beforeId: '1' }]); store.processSecond()
    const page = store.enqueueRead({ pane: 'selected', filter: '', cursor: null, limit: 20 }); store.processSecond()
    await expect(page).resolves.toMatchObject({ items: ['3', '1', '2'] })
  })

  it('moves a selected ID to the end when the drop target has no ID', async () => {
    const store = new InMemoryStore()
    store.enqueueChanges(['1', '2', '3'].map((id) => ({ type: 'selection' as const, id, action: 'select' as const }))); store.processSecond()
    store.enqueueChanges([{ type: 'move', id: '1', beforeId: null }]); store.processSecond()
    const page = store.enqueueRead({ pane: 'selected', filter: '', cursor: null, limit: 20 }); store.processSecond()
    await expect(page).resolves.toMatchObject({ items: ['2', '3', '1'] })
  })
})
