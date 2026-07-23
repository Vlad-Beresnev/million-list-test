import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { api, type Change, type Pane } from './api'
import './styles.css'

function usePagedPane(pane: Pane, revision: number) {
  const [filter, setFilter] = useState('')
  const [items, setItems] = useState<string[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const requestId = useRef(0)
  const load = useCallback(async (nextCursor: string | null, replace: boolean) => {
    const currentRequest = ++requestId.current
    setLoading(true)
    try {
      const page = await api.page(pane, filter.trim(), nextCursor)
      if (currentRequest !== requestId.current) return
      if (page.reset && !replace) { void load(null, true); return }
      console.info('[page]', { pane, filter: filter.trim(), received: page.items.length, revision: page.revision, hasMore: page.hasMore })
      setItems((current) => replace ? page.items : [...current, ...page.items])
      setCursor(page.nextCursor); setHasMore(page.hasMore)
    } finally { if (currentRequest === requestId.current) setLoading(false) }
  }, [filter, pane])
  useEffect(() => { void load(null, true) }, [load, revision])
  return { filter, setFilter, items, setItems, cursor, hasMore, loading, load }
}

const ROW_HEIGHT = 48
const OVERSCAN_ROWS = 6

function PaneView({ title, pane, revision, onSelect, onDeselect, onMove }: {
  title: string; pane: Pane; revision: number; onSelect?: (id: string) => void; onDeselect?: (id: string) => void; onMove?: (id: string, beforeId: string | null) => void
}) {
  const state = usePagedPane(pane, revision)
  const listRef = useRef<HTMLDivElement>(null)
  const dragged = useRef<string | null>(null)
  const loadingMore = useRef(false)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(ROW_HEIGHT)
  useEffect(() => {
    loadingMore.current = state.loading
  }, [state.loading])
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 })
    setScrollTop(0)
  }, [state.filter])
  useEffect(() => {
    const node = listRef.current
    if (!node) return
    const updateHeight = () => setViewportHeight(node.clientHeight)
    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const maximumStartIndex = Math.max(0, state.items.length - Math.ceil(viewportHeight / ROW_HEIGHT))
  const startIndex = Math.min(maximumStartIndex, Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS))
  const endIndex = Math.min(state.items.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN_ROWS)
  const visibleItems = useMemo(() => state.items.slice(startIndex, endIndex), [endIndex, startIndex, state.items])
  const loadNextPage = () => {
    if (!state.hasMore || loadingMore.current) return
    loadingMore.current = true
    void state.load(state.cursor, false).finally(() => { loadingMore.current = false })
  }
  useEffect(() => {
    const node = listRef.current
    if (node && state.hasMore && !state.loading && node.scrollHeight <= node.clientHeight) loadNextPage()
  }, [state.hasMore, state.items.length, state.loading, viewportHeight])
  return <section className="pane">
    <div className="pane-heading"><h2>{title}</h2><span>Загружено: {state.items.length}</span></div>
    <input aria-label={`Фильтрация: ${title}`} value={state.filter} onChange={(event) => state.setFilter(event.target.value)} placeholder="Фильтрация по ID" />
    <div className="rows" ref={listRef} aria-busy={state.loading} onDragOver={(event) => { if (onMove) event.preventDefault() }} onDrop={(event) => {
      if (!onMove || !dragged.current) return
      event.preventDefault()
      onMove(dragged.current, null)
      dragged.current = null
    }} onScroll={(event) => {
      const node = event.currentTarget
      setScrollTop(node.scrollTop)
      if (node.scrollHeight - node.scrollTop - node.clientHeight <= ROW_HEIGHT * 2) loadNextPage()
    }}>
      {visibleItems.length > 0 && <div className="virtual-track">
        <div style={{ height: startIndex * ROW_HEIGHT }} />
        {visibleItems.map((id) => <div className="row" key={id} draggable={Boolean(onMove)}
        onDragStart={(event) => { dragged.current = id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', id) }}
        onDragOver={(event) => { if (onMove) event.preventDefault() }}
        onDrop={(event) => { event.preventDefault(); event.stopPropagation(); if (dragged.current && dragged.current !== id) onMove?.(dragged.current, id); dragged.current = null }}>
        <span className="id">{id}</span>
        {onMove && <span className="handle" aria-label="Перетащить для сортировки">⠿</span>}
        {onSelect && <button onClick={() => onSelect(id)}>Выбрать</button>}
        {onDeselect && <button className="secondary" onClick={() => onDeselect(id)}>Убрать</button>}
      </div>)}
        <div style={{ height: (state.items.length - endIndex) * ROW_HEIGHT }} />
      </div>}
      {!state.loading && state.items.length === 0 && <p className="empty">Подходящие ID не найдены.</p>}
      {state.loading && state.items.length === 0 && <p className="empty">Загрузка…</p>}
    </div>
  </section>
}

function App() {
  const [revision, setRevision] = useState(0)
  const [notice, setNotice] = useState('')
  const latestAddRequest = useRef(0)
  const noticeTimer = useRef<number | null>(null)
  const requestChange = useCallback(async (change: Change) => {
    console.info('[queue] change submitted', change)
    try {
      const result = await api.changes([change])
      console.info('[queue] change processed', { change, revision: result.revision })
      setRevision(result.revision)
    }
    catch { setNotice('Запрос не выполнен. Повторите попытку.') }
  }, [])
  useEffect(() => {
    let active = true
    const poll = async () => {
      try {
        const result = await api.revision()
        if (!active) return
        setRevision((current) => {
          if (result.revision > current) console.info('[sync] server revision changed', { from: current, to: result.revision })
          return Math.max(current, result.revision)
        })
      } catch { /* next poll retries */ }
    }
    void poll(); const timer = window.setInterval(() => void poll(), 1_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])
  useEffect(() => () => { if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current) }, [])
  const add = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const input = new FormData(form).get('id')
    const id = typeof input === 'string' ? input.trim() : ''
    if (!id) return setNotice('Укажите ID.')
    const requestNumber = ++latestAddRequest.current
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    setNotice(`ID «${id}» передаётся в очередь на добавление…`)
    console.info('[queue] add submitted', { id })
    try {
      const result = await api.add(id)
      if (requestNumber !== latestAddRequest.current) return
      console.info('[queue] add queued', { id, queued: result.queued })
      form.reset()
      if (result.queued.length) {
        setNotice(`ID «${id}» будет добавлен в ближайшем 10-секундном пакете.`)
        noticeTimer.current = window.setTimeout(() => {
          if (requestNumber === latestAddRequest.current) setNotice('')
        }, 10_000)
      } else setNotice(`ID «${id}» уже существует или находится в очереди.`)
    } catch (error) {
      console.error('[queue] add failed', { id, error })
      if (requestNumber === latestAddRequest.current) setNotice('Не удалось добавить ID. Повторите попытку.')
    }
  }
  return <main>
    <header><p className="eyebrow">ТЕСТОВОЕ ЗАДАНИЕ НА ПОЗИЦИЮ FULLSTACK</p><h1>Список из 1 000 000 элементов.</h1><p>Выбор и сортировка элементов выполняются через серверную очередь. Список загружается порциями по 20 элементов.</p></header>
    <form className="add-form" onSubmit={add}><label htmlFor="new-id">Добавить новый ID</label><input id="new-id" name="id" placeholder="Например, customer-42" /><button>Добавить ID</button></form>
    {notice && <p className="notice" role="status">{notice}</p>}
    <div className="panes">
      <PaneView title="Доступные ID" pane="available" revision={revision} onSelect={(id) => void requestChange({ type: 'selection', id, action: 'select' })} />
      <PaneView title="Выбранные ID" pane="selected" revision={revision} onDeselect={(id) => void requestChange({ type: 'selection', id, action: 'deselect' })} onMove={(id, beforeId) => void requestChange({ type: 'move', id, beforeId })} />
    </div>
  </main>
}

createRoot(document.getElementById('root')!).render(<App />)
