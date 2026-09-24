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

// POST /api/cards/batch-move - Move multiple cards to another column in one request
// Body: { cardIds: number[], targetColumnId: number, position?: number }
// Responds 404 when the target column itself is missing/unauthorized, otherwise
// 200 with a per-card results array (a single failing card never blocks the others).
router.post('/cards/batch-move', (req, res) => {
  const { cardIds, targetColumnId, position } = req.body;

  if (!Array.isArray(cardIds) || cardIds.length === 0) {
    return res.status(400).json({ error: 'cardIds must be a non-empty array' });
  }
  if (!targetColumnId) {
    return res.status(400).json({ error: 'Target column ID is required' });
  }
  if (cardIds.length > 100) {
    return res.status(400).json({ error: 'Cannot move more than 100 cards at once' });
  }

  const db = getDb();
  try {
    // The target column must exist, belong to the requesting user and be reachable.
    const targetCol = db.prepare(`
      SELECT col.*, b.user_id FROM columns col
      JOIN boards b ON col.board_id = b.id
      WHERE col.id = ?
    `).get(targetColumnId);

    if (!targetCol || targetCol.user_id !== req.user.id) {
      db.close();
      return res.status(404).json({ error: 'Target column not found' });
    }

    // De-duplicate requested ids while preserving first-seen order.
    const uniqueIds = [...new Set(cardIds.map(Number).filter(Number.isInteger))];

    // Verify every card up-front: it must exist, belong to the user, and live on
    // the same board as the target column. Invalid cards are reported per-item.
    const resultById = new Map();
    const movable = [];
    for (const id of uniqueIds) {
      const card = getCardWithOwnership(db, id, req.user.id);
      if (!card || card.user_id !== req.user.id) {
        resultById.set(id, { card_id: id, success: false, error: 'Card not found' });
      } else if (card.board_id !== targetCol.board_id) {
        resultById.set(id, { card_id: id, success: false, error: 'Card is not on the same board' });
      } else {
        movable.push(card);
      }
    }

    const txn = db.transaction(() => {
      // Phase 1: remove every movable card from its current column, shifting the
      // cards behind it down. Cards already in the target column are removed too,
      // so the requested insertion index is interpreted against a column state
      // that contains none of the selected cards.
      const removed = [];
      for (const card of movable) {
        const current = db.prepare('SELECT * FROM cards WHERE id = ?').get(card.id);
        if (!current) {
          resultById.set(card.id, { card_id: card.id, success: false, error: 'Card not found' });
          continue;
        }
        db.prepare(`
          UPDATE cards SET position = position - 1
          WHERE column_id = ? AND position > ?
        `).run(current.column_id, current.position);
        removed.push(current);
      }

      // Phase 2: insert at the requested base index in the submitted order.
      const maxPos = db.prepare(
        'SELECT MAX(position) AS maxPos FROM cards WHERE column_id = ?'
      ).get(targetColumnId);
      let insertAt = position !== undefined && !Number.isNaN(Number(position))
        ? Math.max(0, Math.min(Number(position), (maxPos.maxPos ?? -1) + 1))
        : (maxPos.maxPos ?? -1) + 1;

      for (const card of removed) {
        db.prepare(`
          UPDATE cards SET position = position + 1
          WHERE column_id = ? AND position >= ?
        `).run(targetColumnId, insertAt);
        db.prepare(`
          UPDATE cards SET column_id = ?, position = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(targetColumnId, insertAt, card.id);
        resultById.set(card.id, { card_id: card.id, success: true, position: insertAt });
        insertAt += 1;
      }
    });

    txn();

    // Attach the authoritative updated card rows for successful moves, keeping
    // the result array in the caller's submitted order.
    const results = uniqueIds.map((id) => {
      const result = resultById.get(id);
      if (result && result.success) {
        result.card = db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
      }
      return result;
    });

    db.close();
    const succeeded = results.filter(r => r.success).length;
    res.json({
      target_column_id: targetColumnId,
      succeeded,
      failed: results.length - succeeded,
      results
    });
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to batch move cards' });
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
    const card = getCardWithOwnership(db, req.params.id, req.user.id);
    if (!card || card.user_id !== req.user.id) {
      db.close();
      return res.status(404).json({ error: 'Card not found' });
    }

    // Verify target column belongs to same board and user
    const targetCol = db.prepare(`
      SELECT col.*, b.user_id FROM columns col 
      JOIN boards b ON col.board_id = b.id 
      WHERE col.id = ? AND col.board_id = ?
    `).get(columnId, card.board_id);

    if (!targetCol || targetCol.user_id !== req.user.id) {
      db.close();
      return res.status(404).json({ error: 'Target column not found in this board' });
    }

    const oldColumnId = card.column_id;
    const oldPosition = card.position;

    // Get max position in target column
    const maxPos = db.prepare('SELECT MAX(position) AS maxPos FROM cards WHERE column_id = ?').get(columnId);
    const newPosition = position !== undefined ? Math.min(position, (maxPos.maxPos ?? -1) + 1) : (maxPos.maxPos ?? -1) + 1;

    // Remove card from old position (shift cards down in old column)
    db.prepare(`
      UPDATE cards SET position = position - 1 
      WHERE column_id = ? AND position > ?
    `).run(oldColumnId, oldPosition);

    // Make room in target column (shift cards up in target column)
    db.prepare(`
      UPDATE cards SET position = position + 1 
      WHERE column_id = ? AND position >= ?
    `).run(columnId, newPosition);

    // Move the card
    db.prepare(`
      UPDATE cards SET column_id = ?, position = ?, updated_at = datetime('now') 
      WHERE id = ?
    `).run(columnId, newPosition, req.params.id);

    const updated = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
    db.close();
    res.json(updated);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to move card' });
  }
});

module.exports = router;
