import { defineStore } from 'pinia'
import { ref } from 'vue'
import { boardApi, columnApi, cardApi } from '../api/index.js'

// Deep snapshot of the cards map, used to roll back optimistic placements.
function snapshotCards(cardsMap) {
  const snap = {}
  for (const colId in cardsMap) {
    snap[colId] = cardsMap[colId].map(c => ({ ...c }))
  }
  return snap
}

function restoreCards(cardsRef, snap) {
  const next = {}
  for (const colId in snap) {
    next[colId] = snap[colId].map(c => ({ ...c }))
  }
  cardsRef.value = next
}

// Rebuild every column list: dedupe by id (first occurrence wins) and sort by
// the server-assigned position. This is the single place that guarantees a card
// is never displayed twice after concurrent/rapid operations.
function normalizeColumns(cardsRef) {
  for (const colId in cardsRef.value) {
    const seen = new Set()
    const deduped = []
    for (const card of cardsRef.value[colId]) {
      if (card && !seen.has(card.id)) {
        seen.add(card.id)
        deduped.push(card)
      }
    }
    deduped.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    cardsRef.value[colId] = deduped
  }
}

// Find which column list currently holds a card.
function findCardLocation(cardsMap, cardId) {
  for (const colId in cardsMap) {
    const idx = cardsMap[colId].findIndex(c => c.id === cardId)
    if (idx !== -1) return { colId, idx }
  }
  return null
}

export const useBoardStore = defineStore('board', () => {
  const boards = ref([])
  const currentBoard = ref(null)
  const columns = ref([])
  const cards = ref({}) // keyed by columnId -> [cards]
  const loading = ref(false)

  // ----- Batch selection state -----
  const selectionMode = ref(false)
  const selectedCardIds = ref(new Set())

  // True while a move (single or batch) is in flight. Draggables and batch
  // entry points read this to refuse overlapping submissions.
  const isMoving = ref(false)

  // All moves are serialized through this promise chain so that rapid,
  // consecutive operations are applied server-side and reconciled locally in
  // submission order; the last successful result always wins.
  let moveChain = Promise.resolve()
  function enqueueMove(task) {
    const run = moveChain.then(task, task)
    // Keep the chain alive even if this task rejects.
    moveChain = run.catch(() => {})
    return run
  }

  // Bumped after every drag-driven optimistic placement so the column
  // draggables fully rebuild their DOM from store state (Sortable has already
  // mutated the DOM, and a rebuild removes any chance of duplicated nodes).
  const renderKey = ref(0)
  function bumpRenderKey() {
    renderKey.value += 1
  }

  // Fetch tokens make re-entering a board safe: an older in-flight fetch can
  // never overwrite a newer board's cards.
  let boardLoadToken = 0

  // Board actions
  async function fetchBoards() {
    loading.value = true
    try {
      const res = await boardApi.list()
      boards.value = res.data
    } finally {
      loading.value = false
    }
  }

  async function createBoard(name, description) {
    const res = await boardApi.create(name, description)
    boards.value.unshift(res.data)
    return res.data
  }

  async function deleteBoard(id) {
    await boardApi.delete(id)
    boards.value = boards.value.filter(b => b.id !== id)
  }

  // Column actions
  async function fetchColumns(boardId) {
    loading.value = true
    try {
      const res = await columnApi.list(boardId)
      columns.value = res.data
      // Initialize cards map
      cards.value = {}
      for (const col of res.data) {
        cards.value[col.id] = []
      }
    } finally {
      loading.value = false
    }
  }

  async function addColumn(boardId, name) {
    const res = await columnApi.create(boardId, name)
    columns.value.push(res.data)
    cards.value[res.data.id] = []
    return res.data
  }

  async function renameColumn(colId, name) {
    const res = await columnApi.update(colId, { name })
    const idx = columns.value.findIndex(c => c.id === colId)
    if (idx !== -1) columns.value[idx] = res.data
    return res.data
  }

  async function deleteColumn(colId) {
    await columnApi.delete(colId)
    columns.value = columns.value.filter(c => c.id !== colId)
    delete cards.value[colId]
    // Drop any selection that lived in the deleted column.
    selectedCardIds.value = new Set([...selectedCardIds.value].filter(id => {
      return findCardLocation(cards.value, id) !== null
    }))
  }

  async function reorderColumn(colId, newPosition) {
    const res = await columnApi.update(colId, { position: newPosition })
    // Refresh columns to get correct order
    if (currentBoard.value) {
      await fetchColumns(currentBoard.value.id)
    }
    return res.data
  }

  // Card actions
  async function fetchCards(columnId) {
    const res = await cardApi.list(columnId)
    // Dedupe defensively; store order is the server's ORDER BY position.
    const seen = new Set()
    cards.value[columnId] = res.data.filter(c => {
      if (seen.has(c.id)) return false
      seen.add(c.id)
      return true
    })
    return res.data
  }

  async function fetchAllCards(boardId) {
    const token = ++boardLoadToken
    const cols = columns.value
    const results = await Promise.all(cols.map(col => cardApi.list(col.id)))
    // A newer load (re-entering the board) supersedes this response.
    if (token !== boardLoadToken) return
    const next = {}
    cols.forEach((col, i) => {
      const seen = new Set()
      next[col.id] = results[i].data.filter(c => {
        if (seen.has(c.id)) return false
        seen.add(c.id)
        return true
      })
    })
    cards.value = next
    // Selection may reference cards that vanished while away.
    pruneSelection()
  }

  async function addCard(columnId, data) {
    const res = await cardApi.create(columnId, data)
    if (!cards.value[columnId]) cards.value[columnId] = []
    // Never duplicate an id returned twice by the API.
    if (!cards.value[columnId].some(c => c.id === res.data.id)) {
      cards.value[columnId].push(res.data)
    }
    return res.data
  }

  async function updateCard(cardId, data) {
    const res = await cardApi.update(cardId, data)
    // Update card in the local state (single occurrence — dedupe first).
    for (const colId in cards.value) {
      let found = false
      cards.value[colId] = cards.value[colId].filter(c => {
        if (c.id !== cardId) return true
        if (found) return false // drop duplicates
        found = true
        return true
      })
      const idx = cards.value[colId].findIndex(c => c.id === cardId)
      if (idx !== -1) {
        cards.value[colId][idx] = res.data
        break
      }
    }
    return res.data
  }

  async function deleteCard(cardId) {
    await cardApi.delete(cardId)
    for (const colId in cards.value) {
      cards.value[colId] = cards.value[colId].filter(c => c.id !== cardId)
    }
    selectedCardIds.value.delete(cardId)
  }

  // Apply one authoritative server card row into local state: remove it from
  // every column, then insert it at the reported column/position. Idempotent,
  // so applying the same successful result twice can never duplicate a card.
  function reconcileCard(serverCard) {
    if (!serverCard) return
    for (const colId in cards.value) {
      cards.value[colId] = cards.value[colId].filter(c => c.id !== serverCard.id)
    }
    if (!cards.value[serverCard.column_id]) {
      // Target column disappeared locally; nothing sensible to render.
      return
    }
    cards.value[serverCard.column_id].push({ ...serverCard })
    normalizeColumns(cards)
  }

  // Optimistically place a list of cards at consecutive positions starting at
  // basePosition in the target column. Returns a snapshot for rollback.
  function applyBatchPlacement(cardIds, targetColumnId, basePosition) {
    const snapshot = snapshotCards(cards.value)
    const orderedIds = []
    for (const id of cardIds) if (!orderedIds.includes(id)) orderedIds.push(id)

    const placed = []
    for (const id of orderedIds) {
      let found = null
      for (const colId in cards.value) {
        const idx = cards.value[colId].findIndex(c => c.id === id)
        if (idx !== -1) {
          found = cards.value[colId][idx]
          break
        }
      }
      if (found) placed.push({ ...found })
    }

    for (const card of placed) {
      for (const colId in cards.value) {
        cards.value[colId] = cards.value[colId].filter(c => c.id !== card.id)
      }
    }

    if (cards.value[targetColumnId]) {
      let pos = basePosition
      for (const card of placed) {
        card.column_id = targetColumnId
        card.position = pos
        cards.value[targetColumnId].splice(pos, 0, card)
        pos += 1
      }
    }
    normalizeColumns(cards)
    return snapshot
  }

  function rollback(snapshot) {
    restoreCards(cards, snapshot)
  }

  // Apply per-item batch move results over an optimistic placement. The view
  // passes the snapshot it took BEFORE placing anything: successful items are
  // taken from the authoritative server rows, failed items are restored to
  // exactly where they were. Because batchMove runs inside the serialized move
  // chain, rapid consecutive submissions are reconciled in submission order
  // and the last successful result wins.
  function reconcileBatchResults(results, preMoveSnapshot) {
    restoreCards(cards, preMoveSnapshot)
    for (const result of results) {
      if (result?.success && result.card) {
        reconcileCard(result.card)
      }
    }
    normalizeColumns(cards)
    pruneSelection()
  }

  // Single card move, serialized behind every other move.
  async function moveCard(cardId, targetColumnId, position) {
    return enqueueMove(async () => {
      isMoving.value = true
      try {
        const res = await cardApi.move(cardId, targetColumnId, position)
        reconcileCard(res.data)
        return res.data
      } finally {
        isMoving.value = false
      }
    })
  }

  // Batch move, serialized like every other move. Returns either
  // { response } (200 with per-item results) or { error, response } where
  // response is a synthetic all-failed result (e.g. 404 target column gone),
  // so the view always renders a per-item dialog. The view is responsible for
  // the optimistic placement and reconcileBatchResults afterwards.
  async function batchMove(cardIds, targetColumnId, position) {
    const ids = [...new Set(cardIds.map(Number))]
    if (ids.length === 0) throw new Error('No cards selected')
    return enqueueMove(async () => {
      isMoving.value = true
      try {
        const res = await cardApi.batchMove(ids, targetColumnId, position)
        return { response: res.data }
      } catch (err) {
        const serverError = err.response?.data?.error || 'Failed to move cards'
        return {
          error: err,
          response: {
            target_column_id: targetColumnId,
            succeeded: 0,
            failed: ids.length,
            results: ids.map(id => ({ card_id: id, success: false, error: serverError }))
          }
        }
      } finally {
        isMoving.value = false
      }
    })
  }

  // ----- Selection helpers -----
  function setSelectionMode(on) {
    selectionMode.value = on
    if (!on) selectedCardIds.value = new Set()
  }

  function toggleCardSelected(cardId) {
    const next = new Set(selectedCardIds.value)
    if (next.has(cardId)) next.delete(cardId)
    else next.add(cardId)
    selectedCardIds.value = next
  }

  function selectCards(ids) {
    selectedCardIds.value = new Set(ids)
  }

  function clearSelection() {
    selectedCardIds.value = new Set()
  }

  function pruneSelection() {
    const valid = new Set()
    for (const colId in cards.value) {
      for (const card of cards.value[colId]) valid.add(card.id)
    }
    selectedCardIds.value = new Set([...selectedCardIds.value].filter(id => valid.has(id)))
  }

  function getCard(cardId) {
    for (const colId in cards.value) {
      const card = cards.value[colId].find(c => c.id === cardId)
      if (card) return card
    }
    return null
  }

  function clearBoard() {
    currentBoard.value = null
    columns.value = []
    cards.value = {}
    selectionMode.value = false
    selectedCardIds.value = new Set()
    boardLoadToken += 1 // invalidate any in-flight fetch from the previous board
  }

  return {
    boards, currentBoard, columns, cards, loading,
    selectionMode, selectedCardIds, isMoving, renderKey,
    fetchBoards, createBoard, deleteBoard,
    fetchColumns, addColumn, renameColumn, deleteColumn, reorderColumn,
    fetchCards, fetchAllCards, addCard, updateCard, deleteCard,
    moveCard, batchMove,
    applyBatchPlacement, rollback, reconcileBatchResults, bumpRenderKey,
    setSelectionMode, toggleCardSelected, selectCards, clearSelection, pruneSelection, getCard,
    clearBoard
  }
})
