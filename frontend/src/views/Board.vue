<template>
  <div class="board-page">
    <div class="board-header">
      <div class="board-title">
        <el-button text :icon="ArrowLeft" @click="$router.push('/')">Back</el-button>
        <h2 v-if="boardStore.currentBoard">{{ boardStore.currentBoard.name }}</h2>
      </div>
      <div class="board-actions">
        <el-button
          :type="boardStore.selectionMode ? 'success' : 'default'"
          :icon="boardStore.selectionMode ? Check : Operation"
          @click="toggleSelectionMode"
        >
          {{ boardStore.selectionMode ? 'Done Selecting' : 'Select Multiple' }}
        </el-button>
        <el-button type="primary" :icon="Plus" @click="showAddColumn = true">
          Add Column
        </el-button>
      </div>
    </div>

    <div v-if="boardStore.loading" class="loading-state">
      <el-icon class="is-loading" :size="32"><Loading /></el-icon>
      <p>Loading board...</p>
    </div>

    <div v-else class="columns-container">
      <draggable
        v-model="boardStore.columns"
        item-key="id"
        class="columns-wrapper"
        ghost-class="column-ghost"
        animation="200"
        :disabled="boardStore.isMoving"
        @end="onColumnDragEnd"
      >
        <template #item="{ element: column }">
          <Column
            :column="column"
            :cards="boardStore.cards[column.id] || []"
            :all-columns="boardStore.columns"
            :selection-mode="boardStore.selectionMode"
            :selected-ids="boardStore.selectedCardIds"
            :is-moving="boardStore.isMoving"
            :is-drop-target="preview.targetColumnId === column.id"
            :render-key="boardStore.renderKey"
            @add-card="handleAddCard"
            @edit-card="openCardDetail"
            @delete-card="confirmDeleteCard"
            @move-card="handleSingleMove"
            @rename-column="handleRenameColumn"
            @delete-column="confirmDeleteColumn"
            @toggle-select="onToggleSelect"
            @card-drag-start="onCardDragStart"
            @card-drag-move="onCardDragMove"
            @card-drag-end="onCardDragEnd"
          />
        </template>
      </draggable>
    </div>

    <!-- Batch selection action bar -->
    <transition name="slide-up">
      <div v-if="boardStore.selectionMode" class="selection-bar">
        <div class="selection-info">
          <el-icon><InfoFilled /></el-icon>
          <span>{{ selectedCount }} card(s) selected</span>
          <el-button link type="primary" size="small" @click="selectAll">Select all</el-button>
          <el-button link type="info" size="small" @click="boardStore.clearSelection()">Clear</el-button>
        </div>
        <div class="selection-actions">
          <el-button
            type="primary"
            :icon="Rank"
            :disabled="selectedCount === 0 || boardStore.isMoving"
            @click="openBatchMoveDialog"
          >
            Move {{ selectedCount }} card(s)...
          </el-button>
          <el-button
            type="danger"
            plain
            :icon="Delete"
            :disabled="selectedCount === 0 || boardStore.isMoving"
            @click="confirmBatchDelete"
          >
            Delete
          </el-button>
          <el-button :disabled="boardStore.isMoving" @click="toggleSelectionMode">Exit</el-button>
        </div>
      </div>
    </transition>

    <!-- Drag preview chip -->
    <div
      v-if="preview.visible"
      class="drag-preview-chip"
      :style="{ left: preview.x + 'px', top: preview.y + 'px' }"
    >
      <el-icon><Promotion /></el-icon>
      <span>{{ preview.count }} card(s) → {{ preview.targetName || '…' }}</span>
      <span class="preview-position">drop at #{{ preview.base + 1 }}</span>
    </div>

    <!-- Add Column Dialog -->
    <el-dialog v-model="showAddColumn" title="Add Column" width="400px" :close-on-click-modal="false">
      <el-form @submit.prevent="handleAddColumn">
        <el-form-item label="Column Name">
          <el-input v-model="newColumnName" placeholder="Enter column name" @keyup.enter="handleAddColumn" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddColumn = false">Cancel</el-button>
        <el-button type="primary" :disabled="!newColumnName.trim()" @click="handleAddColumn">Add</el-button>
      </template>
    </el-dialog>

    <!-- Add Card Dialog -->
    <AddCardForm
      v-model:visible="showAddCard"
      :column-id="addingToColumnId"
      @added="onCardAdded"
    />

    <!-- Card Detail Dialog -->
    <CardDetail
      v-model:visible="showCardDetail"
      :card="selectedCard"
      :all-columns="boardStore.columns"
      @updated="onCardUpdated"
      @move="handleSingleMove"
    />

    <!-- Batch move dialog: choose target column, preview destination before submit -->
    <el-dialog
      v-model="showBatchMove"
      :title="`Move ${selectedCount} card(s)`"
      width="480px"
      :close-on-click-modal="false"
    >
      <el-form label-position="top">
        <el-form-item label="Target column">
          <el-select v-model="batchTargetColumnId" placeholder="Select target column" style="width: 100%">
            <el-option
              v-for="col in boardStore.columns"
              :key="col.id"
              :label="col.name"
              :value="col.id"
            />
          </el-select>
        </el-form-item>
      </el-form>

      <div v-if="batchTargetColumnId" class="batch-preview">
        <el-alert
          :closable="false"
          type="info"
          show-icon
          :title="`${selectedCount} card(s) will be added to the end of “${batchTargetName}”.`"
          class="batch-preview-alert"
        />
        <el-scrollbar max-height="180px">
          <ul class="batch-preview-list">
            <li v-for="card in selectedCards" :key="card.id">
              <el-icon class="result-ok"><CircleCheckFilled /></el-icon>
              <span>{{ card.title }}</span>
            </li>
          </ul>
        </el-scrollbar>
      </div>

      <template #footer>
        <el-button @click="showBatchMove = false">Cancel</el-button>
        <el-button
          type="primary"
          :loading="boardStore.isMoving"
          :disabled="!batchTargetColumnId || selectedCount === 0"
          @click="submitBatchMove"
        >
          Move cards
        </el-button>
      </template>
    </el-dialog>

    <!-- Per-item result dialog -->
    <BatchMoveResult
      v-model:visible="showBatchResult"
      :response="batchResponse"
      :card-lookup="cardLookup"
      :target-column-name="batchResultTargetName"
      @retry="retryFailed"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Plus, ArrowLeft, Loading, Check, Operation, Rank, Delete,
  InfoFilled, Promotion, CircleCheckFilled
} from '@element-plus/icons-vue'
import draggable from 'vuedraggable'
import { useBoardStore } from '../stores/board.js'
import { columnApi } from '../api/index.js'
import Column from '../components/Column.vue'
import AddCardForm from '../components/AddCardForm.vue'
import CardDetail from '../components/CardDetail.vue'
import BatchMoveResult from '../components/BatchMoveResult.vue'

const route = useRoute()
const router = useRouter()
const boardStore = useBoardStore()

const showAddColumn = ref(false)
const newColumnName = ref('')
const showAddCard = ref(false)
const addingToColumnId = ref(null)
const showCardDetail = ref(false)
const selectedCard = ref(null)

// ----- Batch selection -----
const showBatchMove = ref(false)
const batchTargetColumnId = ref(null)
const showBatchResult = ref(false)
const batchResponse = ref(null)
const batchResultTargetName = ref('')

const selectedCount = computed(() => boardStore.selectedCardIds.size)

const selectedCards = computed(() => {
  return [...boardStore.selectedCardIds]
    .map(id => boardStore.getCard(id))
    .filter(Boolean)
})

const batchTargetName = computed(() =>
  boardStore.columns.find(c => c.id === batchTargetColumnId.value)?.name || ''
)

// Lookup captured when a result dialog opens: titles must still render even if
// a later rapid operation moves a card elsewhere.
const cardLookup = ref({})

// ----- Drag preview state -----
const preview = ref({
  visible: false,
  count: 0,
  targetColumnId: null,
  targetName: '',
  base: 0,
  x: 0,
  y: 0
})
let dragContext = null // { cardId, fromColumnId, isBatch }

onMounted(async () => {
  const boardId = parseInt(route.params.id)
  boardStore.currentBoard = { id: boardId, name: 'Loading...' }
  try {
    await boardStore.fetchColumns(boardId)
    await boardStore.fetchAllCards(boardId)
    // Get board name from boards list or set from URL
    const boards = boardStore.boards
    const found = boards.find(b => b.id === boardId)
    if (found) {
      boardStore.currentBoard = found
    } else {
      // Fetch boards to get the name
      await boardStore.fetchBoards()
      const b = boardStore.boards.find(b => b.id === boardId)
      if (b) boardStore.currentBoard = b
    }
  } catch (err) {
    ElMessage.error('Failed to load board')
    router.push('/')
  }
  window.addEventListener('mousemove', onDragMouseMove)
})

onUnmounted(() => {
  window.removeEventListener('mousemove', onDragMouseMove)
  clearPreview()
  boardStore.clearBoard()
})

function toggleSelectionMode() {
  boardStore.setSelectionMode(!boardStore.selectionMode)
}

function onToggleSelect(cardId) {
  boardStore.toggleCardSelected(cardId)
}

function selectAll() {
  const ids = []
  for (const colId in boardStore.cards) {
    for (const card of boardStore.cards[colId]) ids.push(card.id)
  }
  boardStore.selectCards(ids)
}

async function handleAddColumn() {
  if (!newColumnName.value.trim()) return
  try {
    await boardStore.addColumn(boardStore.currentBoard.id, newColumnName.value.trim())
    newColumnName.value = ''
    showAddColumn.value = false
    ElMessage.success('Column added')
  } catch (err) {
    ElMessage.error('Failed to add column')
  }
}

function handleAddCard(columnId) {
  addingToColumnId.value = columnId
  showAddCard.value = true
}

function onCardAdded() {
  showAddCard.value = false
}

function openCardDetail(card) {
  selectedCard.value = { ...card }
  showCardDetail.value = true
}

function onCardUpdated(updatedCard) {
  selectedCard.value = { ...updatedCard }
}

async function confirmDeleteCard(card) {
  try {
    await ElMessageBox.confirm(
      `Delete "${card.title}"?`,
      'Delete Card',
      { type: 'warning', confirmButtonText: 'Delete', cancelButtonText: 'Cancel' }
    )
    await boardStore.deleteCard(card.id)
    ElMessage.success('Card deleted')
  } catch (err) {
    // cancelled
  }
}

async function confirmBatchDelete() {
  const ids = [...boardStore.selectedCardIds]
  if (ids.length === 0) return
  try {
    await ElMessageBox.confirm(
      `Delete ${ids.length} selected card(s)?`,
      'Delete Cards',
      { type: 'warning', confirmButtonText: 'Delete', cancelButtonText: 'Cancel' }
    )
  } catch (err) {
    return // cancelled
  }
  // Serialize deletes through the same move lock so they can't interleave.
  let failures = 0
  for (const id of ids) {
    try {
      await boardStore.deleteCard(id)
    } catch (err) {
      failures += 1
    }
  }
  boardStore.clearSelection()
  if (failures === 0) ElMessage.success(`${ids.length} card(s) deleted`)
  else ElMessage.error(`${failures} of ${ids.length} card(s) could not be deleted`)
}

// Original menu-driven single-card move entry point (card menu and detail dialog).
async function handleSingleMove(cardId, targetColumnId, position) {
  try {
    await boardStore.moveCard(cardId, targetColumnId, position)
    ElMessage.success('Card moved')
  } catch (err) {
    ElMessage.error(err.response?.data?.error || 'Failed to move card')
  }
}

async function handleRenameColumn(columnId, newName) {
  try {
    await boardStore.renameColumn(columnId, newName)
    ElMessage.success('Column renamed')
  } catch (err) {
    ElMessage.error('Failed to rename column')
  }
}

async function confirmDeleteColumn(column) {
  const cardCount = (boardStore.cards[column.id] || []).length
  const msg = cardCount > 0
    ? `Delete "${column.name}" and its ${cardCount} card(s)?`
    : `Delete "${column.name}"?`
  try {
    await ElMessageBox.confirm(msg, 'Delete Column', {
      type: 'warning',
      confirmButtonText: 'Delete',
      cancelButtonText: 'Cancel'
    })
    await boardStore.deleteColumn(column.id)
    ElMessage.success('Column deleted')
  } catch (err) {
    // cancelled
  }
}

async function onColumnDragEnd(evt) {
  // Update column positions after drag
  const columns = boardStore.columns
  for (let i = 0; i < columns.length; i++) {
    if (columns[i].position !== i) {
      try {
        await columnApi.update(columns[i].id, { position: i })
        columns[i].position = i
      } catch (err) {
        // Refresh to get correct state
        await boardStore.fetchColumns(boardStore.currentBoard.id)
        break
      }
    }
  }
}

// ----- Batch move dialog -----
function openBatchMoveDialog() {
  if (selectedCount.value === 0) return
  batchTargetColumnId.value = null
  showBatchMove.value = true
}

function snapshotLayout() {
  const snap = {}
  for (const colId in boardStore.cards) {
    snap[colId] = boardStore.cards[colId].map(c => ({ ...c }))
  }
  return snap
}

function buildCardLookup() {
  const lookup = {}
  for (const colId in boardStore.cards) {
    for (const card of boardStore.cards[colId]) lookup[card.id] = card
  }
  return lookup
}

async function submitBatchMove(targetColumnId = batchTargetColumnId.value, idsOverride = null) {
  const ids = idsOverride
    ? [...new Set(idsOverride.map(Number))]
    : [...boardStore.selectedCardIds]
  if (ids.length === 0 || !targetColumnId) return

  // Guard against rapid double-submission / re-entered dialog.
  if (boardStore.isMoving) return

  const target = boardStore.columns.find(c => c.id === targetColumnId)
  const snapshot = snapshotLayout()

  // Menu-driven move appends at the end of the target column.
  const endIndex = (boardStore.cards[targetColumnId] || []).length
  boardStore.applyBatchPlacement(ids, targetColumnId, endIndex)
  boardStore.bumpRenderKey()

  showBatchMove.value = false
  const { response, error } = await boardStore.batchMove(ids, targetColumnId, endIndex)

  // Positions reflect the last successful result only.
  boardStore.reconcileBatchResults(response.results, snapshot)
  boardStore.bumpRenderKey()

  cardLookup.value = buildCardLookup()
  batchResponse.value = response
  batchResultTargetName.value = target?.name || ''
  showBatchResult.value = true

  if (error && error.response?.status === 404) {
    // Target column was deleted out from under us — resync columns/cards so
    // the UI can never render a card in a column that no longer exists.
    await resyncBoard()
  } else if (!error && response.failed === 0) {
    // Full success: selection has moved together; clear it so cards cannot be
    // resubmitted twice.
    boardStore.clearSelection()
  } else if (!error) {
    // Partial failure: keep only the still-present failed cards selected for retry.
    const failedIds = new Set(response.results.filter(r => !r.success).map(r => r.card_id))
    boardStore.selectCards([...failedIds].filter(id => boardStore.getCard(id)))
  }
  // Total failure: keep selection untouched so the user can retry.
}

async function resyncBoard() {
  if (!boardStore.currentBoard?.id) return
  await boardStore.fetchColumns(boardStore.currentBoard.id)
  await boardStore.fetchAllCards(boardStore.currentBoard.id)
}

async function retryFailed(failedIds) {
  showBatchResult.value = false
  if (failedIds.length === 0) return
  // Retry to the same target column, appended at end.
  const targetColumnId = batchResponse.value?.target_column_id
  if (!targetColumnId) return
  await submitBatchMove(targetColumnId, failedIds)
}

// ----- Card drag handling (single + batch) -----
function onDragMouseMove(e) {
  if (!preview.value.visible) return
  preview.value.x = e.clientX + 14
  preview.value.y = e.clientY + 14
}

function clearPreview() {
  preview.value = { visible: false, count: 0, targetColumnId: null, targetName: '', base: 0, x: 0, y: 0 }
}

function onCardDragStart({ cardId, fromColumnId }) {
  const isBatch = boardStore.selectionMode && boardStore.selectedCardIds.has(cardId)
  dragContext = { cardId, fromColumnId, isBatch }
  if (isBatch) {
    preview.value.visible = true
    preview.value.count = boardStore.selectedCardIds.size
    preview.value.targetColumnId = fromColumnId
    preview.value.targetName = boardStore.columns.find(c => c.id === fromColumnId)?.name || ''
    preview.value.base = computeBase(fromColumnId, null)
  }
}

function onCardDragMove({ toColumnId, relatedId }) {
  if (!dragContext?.isBatch) return
  preview.value.targetColumnId = toColumnId
  preview.value.targetName = boardStore.columns.find(c => c.id === toColumnId)?.name || ''
  preview.value.base = computeBase(toColumnId, relatedId)
}

// Base insertion index: index among target-column cards that are NOT part of
// the multi-selection (the selected ones are conceptually already "in hand").
function computeBase(toColumnId, relatedId) {
  const list = boardStore.cards[toColumnId] || []
  if (relatedId == null) {
    return list.filter(c => !boardStore.selectedCardIds.has(c.id)).length
  }
  let base = 0
  for (const card of list) {
    if (card.id === relatedId) break
    if (!boardStore.selectedCardIds.has(card.id)) base += 1
  }
  return base
}

async function onCardDragEnd({ cardId, fromColumnId, toColumnId, oldIndex, newIndex, relatedId }) {
  const ctx = dragContext
  dragContext = null
  clearPreview()
  if (!ctx) return

  // ----- Single-card drag (original entry point, preserved) -----
  if (!ctx.isBatch) {
    const index = Number.isInteger(newIndex) ? newIndex : (boardStore.cards[toColumnId]?.length ?? 0)
    // No actual movement; nothing was committed.
    if (fromColumnId === toColumnId && oldIndex === index) return
    try {
      // Sortable already shows the new spot in the DOM; reconcile against the
      // server first, then rebuild the DOM once (avoids a back-flash).
      await boardStore.moveCard(cardId, toColumnId, index)
    } catch (err) {
      // Server rejected it; the rebuild below restores the authoritative layout.
    }
    boardStore.bumpRenderKey()
    return
  }

  // ----- Batch drag -----
  const ids = [...boardStore.selectedCardIds]
  if (ids.length === 0) {
    boardStore.bumpRenderKey()
    return
  }

  const base = computeBase(toColumnId, relatedId)

  // Skip a pure no-op: selected cards already occupy the target slot in order.
  if (isBatchNoOp(ids, toColumnId, base)) {
    boardStore.bumpRenderKey()
    return
  }

  const target = boardStore.columns.find(c => c.id === toColumnId)
  const snapshot = snapshotLayout()

  // Optimistic preview-commit: show the batch at the drop spot immediately.
  boardStore.applyBatchPlacement(ids, toColumnId, base)
  boardStore.bumpRenderKey()

  const { response, error } = await boardStore.batchMove(ids, toColumnId, base)
  boardStore.reconcileBatchResults(response.results, snapshot)
  boardStore.bumpRenderKey()

  cardLookup.value = buildCardLookup()
  batchResponse.value = response
  batchResultTargetName.value = target?.name || ''
  showBatchResult.value = true

  if (error && error.response?.status === 404) {
    await resyncBoard()
  } else if (!error && response.failed === 0) {
    boardStore.clearSelection()
  } else if (!error) {
    const failedIds = new Set(response.results.filter(r => !r.success).map(r => r.card_id))
    boardStore.selectCards([...failedIds].filter(id => boardStore.getCard(id)))
  }
}

function isBatchNoOp(ids, targetColumnId, base) {
  const list = boardStore.cards[targetColumnId] || []
  if (ids.some(id => !list.some(c => c.id === id))) return false
  const windowSlice = list.slice(base, base + ids.length)
  if (windowSlice.length !== ids.length) return false
  // Every card at the landing window must be one of the selected cards, i.e.
  // the batch already sits there contiguously (order shown doesn't matter —
  // the server will rewrite consecutive positions anyway).
  return windowSlice.every(c => ids.includes(c.id))
}
</script>

<style scoped>
.board-page {
  padding: 20px;
  height: calc(100vh - 60px);
  display: flex;
  flex-direction: column;
}

.board-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  flex-shrink: 0;
}

.board-title {
  display: flex;
  align-items: center;
  gap: 12px;
}

.board-title h2 {
  font-size: 22px;
  color: #303133;
}

.board-actions {
  display: flex;
  gap: 8px;
}

.columns-container {
  flex: 1;
  overflow-x: auto;
  overflow-y: hidden;
}

.columns-wrapper {
  display: flex;
  gap: 16px;
  height: 100%;
  min-height: 400px;
}

.column-ghost {
  opacity: 0.5;
  background: #e8f4ff;
  border-radius: 8px;
}

.loading-state {
  text-align: center;
  padding: 60px;
  color: #909399;
}

.loading-state p {
  margin-top: 12px;
}

/* Selection action bar */
.selection-bar {
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 20px;
  background: #fff;
  border: 1px solid #dcdfe6;
  border-radius: 10px;
  padding: 10px 16px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.12);
  z-index: 100;
}

.selection-info {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #303133;
}

.selection-actions {
  display: flex;
  gap: 8px;
}

.slide-up-enter-active,
.slide-up-leave-active {
  transition: all 0.2s ease;
}

.slide-up-enter-from,
.slide-up-leave-to {
  opacity: 0;
  transform: translate(-50%, 16px);
}

/* Drag preview chip */
.drag-preview-chip {
  position: fixed;
  z-index: 2000;
  pointer-events: none;
  display: flex;
  align-items: center;
  gap: 6px;
  background: #409eff;
  color: #fff;
  font-size: 12px;
  padding: 6px 10px;
  border-radius: 16px;
  box-shadow: 0 4px 12px rgba(64, 158, 255, 0.4);
}

.drag-preview-chip .preview-position {
  opacity: 0.85;
  border-left: 1px solid rgba(255, 255, 255, 0.5);
  padding-left: 6px;
}

/* Batch move dialog preview */
.batch-preview {
  margin-top: 8px;
}

.batch-preview-alert {
  margin-bottom: 10px;
}

.batch-preview-list {
  list-style: none;
  margin: 0;
  padding: 0 4px;
}

.batch-preview-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  font-size: 13px;
  color: #303133;
  border-bottom: 1px solid #f2f6fc;
}

.result-ok {
  color: #67c23a;
}
</style>
