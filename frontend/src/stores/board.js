import { defineStore } from 'pinia'
import { ref } from 'vue'
import { boardApi, columnApi, cardApi } from '../api/index.js'

export const useBoardStore = defineStore('board', () => {
  const boards = ref([])
  const currentBoard = ref(null)
  const columns = ref([])
  const cards = ref({}) // keyed by columnId -> [cards]
  const loading = ref(false)

  // Multi-select state for batch moves
  const selectedCardIds = ref([])

  // Serialize move operations so rapid consecutive actions cannot race
  // each other and leave duplicated cards in the local state.
  let moveQueue = Promise.resolve()
  function enqueueMove(task) {
    const run = moveQueue.then(task, task)
    moveQueue = run.catch(() => {})
    return run
  }

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
    cards.value[columnId] = res.data
    return res.data
  }

  async function fetchAllCards(boardId) {
    // Fetch cards for all columns in parallel
    const cols = columns.value
    const promises = cols.map(col => cardApi.list(col.id))
    const results = await Promise.all(promises)
    cols.forEach((col, i) => {
      cards.value[col.id] = results[i].data
    })
  }

  // Re-fetch columns + cards and replace local state wholesale. This is the
  // authoritative reconciliation used after (batch) moves and after any move
  // failure, so cards can never appear duplicated or in a stale position.
  // Data is fetched before any reactive swap to avoid an empty flicker.
  async function refreshBoardState() {
    if (!currentBoard.value) return
    const res = await columnApi.list(currentBoard.value.id)
    const results = await Promise.all(res.data.map(col => cardApi.list(col.id)))
    const nextCards = {}
    res.data.forEach((col, i) => {
      nextCards[col.id] = results[i].data
    })
    columns.value = res.data
    cards.value = nextCards
  }

  async function addCard(columnId, data) {
    const res = await cardApi.create(columnId, data)
    if (!cards.value[columnId]) cards.value[columnId] = []
    cards.value[columnId].push(res.data)
    return res.data
  }

  async function updateCard(cardId, data) {
    const res = await cardApi.update(cardId, data)
    // Update card in the local state
    for (const colId in cards.value) {
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
  }

  async function moveCard(cardId, targetColumnId, position) {
    return enqueueMove(async () => {
      try {
        await cardApi.move(cardId, targetColumnId, position)
        // Reconcile from the server: the persisted position is the source of
        // truth, and a wholesale replacement can never duplicate a card
        // (including under rapid repeated moves).
        await refreshBoardState()
      } catch (err) {
        // Failed move (e.g. target column deleted concurrently): reconcile
        // too, so the optimistic drag state snaps back to the server state.
        try { await refreshBoardState() } catch (_) { /* keep original error */ }
        throw err
      }
    })
  }

  /**
   * Batch move. Queued behind any in-flight move to avoid races from rapid
   * repeated submissions. After the request, local state is replaced with a
   * fresh fetch: the final positions are taken from the last successful
   * server result, and failed cards simply stay where the server left them —
   * no optimistic insert means no duplicates on partial failure.
   *
   * @param {Array<{cardId:number, columnId:number, position?:number}>} moves
   * @returns {Array<{cardId:number, success:boolean, card?:object, error?:string}>}
   */
  async function moveCards(moves) {
    return enqueueMove(async () => {
      try {
        const res = await cardApi.batchMove(moves)
        await refreshBoardState()
        return res.data.results
      } catch (err) {
        // Whole request failed (network/500): reconcile and surface failure.
        try { await refreshBoardState() } catch (_) { /* keep error below */ }
        return moves.map(m => ({
          cardId: m.cardId,
          success: false,
          error: err?.response?.data?.error || 'Request failed'
        }))
      }
    })
  }

  // Selection helpers (local-only UI state, cleared on board exit)
  function toggleCardSelection(cardId) {
    const idx = selectedCardIds.value.indexOf(cardId)
    if (idx === -1) selectedCardIds.value.push(cardId)
    else selectedCardIds.value.splice(idx, 1)
  }

  function setSelected(ids) {
    // Dedupe defensively so a card can never be rendered/processed twice.
    selectedCardIds.value = [...new Set(ids)]
  }

  function clearSelection() {
    selectedCardIds.value = []
  }

  function clearBoard() {
    currentBoard.value = null
    columns.value = []
    cards.value = {}
    selectedCardIds.value = []
  }

  return {
    boards, currentBoard, columns, cards, loading, selectedCardIds,
    fetchBoards, createBoard, deleteBoard,
    fetchColumns, addColumn, renameColumn, deleteColumn, reorderColumn,
    fetchCards, fetchAllCards, refreshBoardState,
    addCard, updateCard, deleteCard, moveCard, moveCards,
    toggleCardSelection, setSelected, clearSelection,
    clearBoard
  }
})
