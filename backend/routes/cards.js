const express = require('express');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

router.use(authMiddleware);

// Helper: verify card ownership through column -> board -> user
function getCardWithOwnership(db, cardId, userId) {
  return db.prepare(`
    SELECT c.*, col.board_id, b.user_id 
    FROM cards c
    JOIN columns col ON c.column_id = col.id
    JOIN boards b ON col.board_id = b.id
    WHERE c.id = ?
  `).get(cardId);
}

function verifyColumnOwnership(db, columnId, userId) {
  return db.prepare(`
    SELECT col.*, b.user_id
    FROM columns col
    JOIN boards b ON col.board_id = b.id
    WHERE col.id = ?
  `).get(columnId, userId);
}

/**
 * Validate and execute one or more card moves.
 * Validation is per item so that a single bad card (missing target column,
 * no ownership, duplicate entry) fails individually instead of aborting the
 * whole batch. All valid moves are applied inside one transaction with a
 * two-phase algorithm:
 *   1. remove every moving card and compact the affected columns
 *   2. insert cards into their target columns in request order
 * Returns results aligned to the input order:
 *   { cardId, success: true, card } or { cardId, success: false, status, error }
 * Throws only on an unexpected database error (transaction is rolled back).
 */
function executeMoves(db, rawItems, userId) {
  const results = new Array(rawItems.length);
  const candidates = [];
  const seenCardIds = new Set();

  rawItems.forEach((item, index) => {
    const cardId = Number.isInteger(item?.cardId) ? item.cardId : null;
    const columnId = Number.isInteger(item?.columnId) ? item.columnId : null;

    if (cardId === null || columnId === null) {
      results[index] = {
        cardId: cardId ?? (item?.cardId ?? null),
        success: false,
        status: 400,
        error: 'cardId and columnId are required integers'
      };
      return;
    }

    if (seenCardIds.has(cardId)) {
      results[index] = {
        cardId,
        success: false,
        status: 400,
        error: 'Card is included more than once in this request'
      };
      return;
    }
    seenCardIds.add(cardId);

    const card = getCardWithOwnership(db, cardId, userId);
    if (!card || card.user_id !== userId) {
      results[index] = { cardId, success: false, status: 404, error: 'Card not found' };
      return;
    }

    const targetCol = db.prepare(`
      SELECT col.*, b.user_id FROM columns col
      JOIN boards b ON col.board_id = b.id
      WHERE col.id = ? AND col.board_id = ?
    `).get(columnId, card.board_id);

    if (!targetCol || targetCol.user_id !== userId) {
      results[index] = {
        cardId,
        success: false,
        status: 404,
        error: 'Target column not found in this board'
      };
      return;
    }

    candidates.push({
      index,
      cardId,
      columnId,
      position: Number.isInteger(item.position) ? item.position : null
    });
  });

  if (candidates.length > 0) {
    const applyMoves = db.transaction(() => {
      const movingIds = new Set(candidates.map(c => c.cardId));

      // Every source column of a moving card plus every target column needs
      // compaction/reindexing.
      const affectedColumns = new Set();
      for (const c of candidates) {
        const row = db.prepare('SELECT column_id FROM cards WHERE id = ?').get(c.cardId);
        if (row) affectedColumns.add(row.column_id);
        affectedColumns.add(c.columnId);
      }

      // Phase 1: drop moving cards, re-index the survivors 0..n-1.
      for (const colId of affectedColumns) {
        const survivors = db.prepare(`
          SELECT id FROM cards
          WHERE column_id = ?
          ORDER BY position ASC, id ASC
        `).all(colId).filter(r => !movingIds.has(r.id));

        const reindex = db.prepare('UPDATE cards SET position = ? WHERE id = ?');
        survivors.forEach((r, i) => reindex.run(i, r.id));
      }

      // Phase 2: insert in request order. The first card heading to a given
      // column lands at the requested point; subsequent cards targeting the
      // same column land right after it, so a batch keeps the selection's
      // order as one contiguous block at the drop point.
      const makeRoom = db.prepare(`
        UPDATE cards SET position = position + 1
        WHERE column_id = ? AND position >= ?
      `);
      const placeCard = db.prepare(`
        UPDATE cards SET column_id = ?, position = ?, updated_at = datetime('now')
        WHERE id = ?
      `);
      const countCards = db.prepare(
        'SELECT COUNT(*) AS n FROM cards WHERE column_id = ?'
      );

      // Per target column: base landing position and how many batch cards
      // have already been inserted into it.
      const insertInfo = new Map();

      for (const m of candidates) {
        let info = insertInfo.get(m.columnId);
        if (!info) {
          const count = countCards.get(m.columnId).n;
          const base = m.position === null
            ? count
            : Math.max(0, Math.min(m.position, count));
          info = { base, inserted: 0 };
          insertInfo.set(m.columnId, info);
        }
        const position = info.base + info.inserted;

        makeRoom.run(m.columnId, position);
        placeCard.run(m.columnId, position, m.cardId);
        info.inserted++;
      }
    });
    applyMoves();

    const fetchCard = db.prepare('SELECT * FROM cards WHERE id = ?');
    for (const m of candidates) {
      results[m.index] = { cardId: m.cardId, success: true, card: fetchCard.get(m.cardId) };
    }
  }

  return { results };
}

// GET /api/columns/:columnId/cards - Get cards in column
router.get('/columns/:columnId/cards', (req, res) => {
  const db = getDb();
  try {
    const col = db.prepare(`
      SELECT col.*, b.user_id FROM columns col 
      JOIN boards b ON col.board_id = b.id 
      WHERE col.id = ?
    `).get(req.params.columnId);

    if (!col || col.user_id !== req.user.id) {
      db.close();
      return res.status(404).json({ error: 'Column not found' });
    }

    const cards = db.prepare(`
      SELECT * FROM cards 
      WHERE column_id = ? 
      ORDER BY position ASC
    `).all(req.params.columnId);

    db.close();
    res.json(cards);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to fetch cards' });
  }
});

// POST /api/columns/:columnId/cards - Add card
router.post('/columns/:columnId/cards', (req, res) => {
  const { title, description, priority, due_date } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Card title is required' });
  }

  const db = getDb();
  try {
    const col = db.prepare(`
      SELECT col.*, b.user_id FROM columns col 
      JOIN boards b ON col.board_id = b.id 
      WHERE col.id = ?
    `).get(req.params.columnId);

    if (!col || col.user_id !== req.user.id) {
      db.close();
      return res.status(404).json({ error: 'Column not found' });
    }

    // Get max position in this column
    const maxPos = db.prepare('SELECT MAX(position) AS maxPos FROM cards WHERE column_id = ?').get(req.params.columnId);
    const newPosition = (maxPos.maxPos ?? -1) + 1;

    const result = db.prepare(`
      INSERT INTO cards (column_id, title, description, priority, due_date, position) 
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      req.params.columnId,
      title.trim(),
      description || '',
      priority || 'medium',
      due_date || null,
      newPosition
    );

    const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(result.lastInsertRowid);
    db.close();
    res.status(201).json(card);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to create card' });
  }
});

// PUT /api/cards/:id - Update card
router.put('/cards/:id', (req, res) => {
  const { title, description, priority, due_date } = req.body;
  const db = getDb();

  try {
    const card = getCardWithOwnership(db, req.params.id, req.user.id);
    if (!card || card.user_id !== req.user.id) {
      db.close();
      return res.status(404).json({ error: 'Card not found' });
    }

    const updates = [];
    const params = [];

    if (title !== undefined) { updates.push('title = ?'); params.push(title.trim()); }
    if (description !== undefined) { updates.push('description = ?'); params.push(description); }
    if (priority !== undefined) { updates.push('priority = ?'); params.push(priority); }
    if (due_date !== undefined) { updates.push('due_date = ?'); params.push(due_date || null); }

    updates.push("updated_at = datetime('now')");

    if (updates.length > 0) {
      params.push(req.params.id);
      db.prepare(`UPDATE cards SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }

    const updated = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
    db.close();
    res.json(updated);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to update card' });
  }
});

// DELETE /api/cards/:id - Delete card
router.delete('/cards/:id', (req, res) => {
  const db = getDb();
  try {
    const card = getCardWithOwnership(db, req.params.id, req.user.id);
    if (!card || card.user_id !== req.user.id) {
      db.close();
      return res.status(404).json({ error: 'Card not found' });
    }

    db.prepare('DELETE FROM cards WHERE id = ?').run(req.params.id);

    // Reorder remaining cards in the column
    db.prepare(`
      UPDATE cards SET position = position - 1 
      WHERE column_id = ? AND position > ?
    `).run(card.column_id, card.position);

    db.close();
    res.json({ message: 'Card deleted' });
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to delete card' });
  }
});

// PUT /api/cards/:id/move - Move card to another column
router.put('/cards/:id/move', (req, res) => {
  const { columnId, position } = req.body;
  if (!columnId) {
    return res.status(400).json({ error: 'Target column ID is required' });
  }

  const db = getDb();
  try {
    const { results } = executeMoves(db, [{
      cardId: parseInt(req.params.id, 10),
      columnId,
      position
    }], req.user.id);

    const result = results[0];
    db.close();

    if (!result.success) {
      return res.status(result.status).json({ error: result.error });
    }
    res.json(result.card);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to move card' });
  }
});

// POST /api/cards/batch-move - Move multiple cards in one request.
// Body: { moves: [{ cardId, columnId, position? }] }
// Each item is validated independently; valid moves are applied atomically.
// Responds 200 with per-card results so the client can show which cards
// succeeded and which failed (e.g. target column deleted concurrently).
router.post('/cards/batch-move', (req, res) => {
  const { moves } = req.body;
  if (!Array.isArray(moves) || moves.length === 0) {
    return res.status(400).json({ error: 'moves must be a non-empty array' });
  }

  const db = getDb();
  try {
    const { results } = executeMoves(db, moves, req.user.id);
    db.close();
    res.json({ results });
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to move cards' });
  }
});

module.exports = router;
