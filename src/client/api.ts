export type Pane = 'available' | 'selected'
export type Change =
  | { type: 'selection'; id: string; action: 'select' | 'deselect' }
  | { type: 'move'; id: string; beforeId: string | null }
export interface Page { items: string[]; nextCursor: string | null; hasMore: boolean; revision: number; reset?: boolean }

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let networkError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, init)
      if (!response.ok) throw new Error(`Request failed: ${response.status}`)
      return response.json() as Promise<T>
    } catch (error) {
      networkError = error
      // Vite can briefly drop its proxy connection while the local server restarts.
      if (attempt < 2 && !(error instanceof Error && error.message.startsWith('Request failed:'))) await new Promise((resolve) => window.setTimeout(resolve, 250 * (attempt + 1)))
      else throw error
    }
  }
  throw networkError
}

export const api = {
  revision: () => request<{ revision: number }>('/api/revision'),
  page: (pane: Pane, filter: string, cursor: string | null) => {
    const params = new URLSearchParams({ pane, filter, limit: '20' })
    if (cursor) params.set('cursor', cursor)
    return request<Page>(`/api/items?${params}`)
  },
  changes: (changes: Change[]) => request<{ revision: number }>('/api/changes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ changes }) }),
  add: (id: string) => request<{ queued: string[] }>('/api/ids', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [id] }) }),
}
