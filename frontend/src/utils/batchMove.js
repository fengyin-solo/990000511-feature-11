/**
 * Client-side simulation of the server's batch move algorithm
 * (backend/routes/cards.js -> executeMoves). Used to preview the target
 * column and landing point before a batch move is submitted, so the
 * preview matches what the server will actually persist.
 *
 * @param {Array<{id:number, name:string}>} columns board columns in order
 * @param {Object<number, Array>} cardsMap columnId -> cards (ordered)
 * @param {Array<{cardId:number, columnId:number, position?:number}>} moves
 * @returns {{ byColumn: Object<number, Array>, inserted: Array<{cardId:number, columnId:number, position:number}> }}
 *   byColumn: full simulated card lists per affected column
 *   inserted: landing info for each move (position is the final index)
 */
export function simulateBatchMove(columns, cardsMap, moves) {
  // Deep-copy card lists so the store state is never mutated.
  const byColumn = {}
  for (const col of columns) {
    byColumn[col.id] = (cardsMap[col.id] || []).slice()
  }

  const cardIndex = new Map()
  for (const col of columns) {
    for (const card of byColumn[col.id]) {
      cardIndex.set(card.id, card)
    }
  }

  // Keep only moves whose card and target column both exist locally,
  // mirroring the server-side per-item validation.
  const valid = moves.filter(m => cardIndex.has(m.cardId) && byColumn[m.columnId])
  const movingIds = new Set(valid.map(m => m.cardId))

  // Phase 1: remove moving cards from every column.
  for (const col of columns) {
    byColumn[col.id] = byColumn[col.id].filter(c => !movingIds.has(c.id))
  }

  // Phase 2: insert in request order. First card into a target column lands
  // at the requested point; following cards land right after it, keeping the
  // selection order as one contiguous block at the drop point.
  const inserted = []
  const insertInfo = new Map()
  for (const m of valid) {
    const list = byColumn[m.columnId]
    let info = insertInfo.get(m.columnId)
    if (!info) {
      const base = m.position == null
        ? list.length
        : Math.max(0, Math.min(m.position, list.length))
      info = { base, inserted: 0 }
      insertInfo.set(m.columnId, info)
    }
    const pos = info.base + info.inserted
    list.splice(pos, 0, cardIndex.get(m.cardId))
    info.inserted++
    inserted.push({ cardId: m.cardId, columnId: m.columnId, position: pos })
  }

  return { byColumn, inserted }
}
