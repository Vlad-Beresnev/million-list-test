export const BUILT_IN_MAX_ID = 1_000_000

export type SearchRequest =
  | { type: 'builtIn'; filter: string; start: number; limit: number; excludedIds: string[] }
  | { type: 'selected'; filter: string; start: number; limit: number; ids: string[] }

export interface SearchResult { items: string[]; nextStart: number; hasMore: boolean }

export function executeSearch(request: SearchRequest): SearchResult {
  const items: string[] = []
  let nextStart = request.start
  const push = (id: string, next: number): boolean => {
    if (!id.includes(request.filter)) return false
    if (items.length === request.limit) return true
    items.push(id)
    nextStart = next
    return false
  }

  if (request.type === 'builtIn') {
    const excluded = new Set(request.excludedIds)
    for (let value = request.start; value <= BUILT_IN_MAX_ID; value += 1) {
      const id = String(value)
      if (!excluded.has(id) && push(id, value + 1)) return { items, nextStart, hasMore: true }
    }
    return { items, nextStart, hasMore: false }
  }

  for (let index = request.start; index < request.ids.length; index += 1) {
    if (push(request.ids[index], index + 1)) return { items, nextStart, hasMore: true }
  }
  return { items, nextStart, hasMore: false }
}
