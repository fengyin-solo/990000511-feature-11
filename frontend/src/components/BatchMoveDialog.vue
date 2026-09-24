<template>
  <el-dialog
    :model-value="visible"
    title="Batch Move Cards"
    width="560px"
    :close-on-click-modal="false"
    @update:model-value="$emit('update:visible', $event)"
    @open="resetState"
  >
    <!-- Step 1: choose target column and landing point -->
    <div v-if="!results">
      <div class="selection-summary">
        <el-tag type="info" effect="plain" size="large">
          {{ selectedCards.length }} card(s) selected
        </el-tag>
      </div>

      <el-alert
        v-if="selectedCards.length === 0"
        title="No cards selected. Close this dialog and tick the cards you want to move."
        type="warning"
        :closable="false"
        show-icon
        style="margin-bottom: 16px;"
      />

      <el-form label-position="top">
        <el-form-item label="Target column">
          <el-select
            v-model="targetColumnId"
            placeholder="Select target column"
            style="width: 100%;"
          >
            <el-option
              v-for="col in allColumns"
              :key="col.id"
              :label="col.name"
              :value="col.id"
            />
          </el-select>
        </el-form-item>
      </el-form>

      <div v-if="targetColumnId !== null" class="preview-section">
        <p class="preview-hint">
          Preview — moving cards land as the highlighted block. Click a gap to
          change the drop point.
        </p>
        <div class="preview-list" :class="{ busy: submitting }">
          <template v-for="(row, idx) in previewRows" :key="row.key">
            <div
              class="drop-gap"
              :class="{ active: landingPosition === idx && !submitting }"
              @click="landingPosition = idx"
            >
              <span class="gap-line"></span>
              <el-icon v-if="landingPosition === idx" class="gap-icon"><Top /></el-icon>
            </div>
            <div
              v-if="row.type === 'card'"
              class="preview-card"
              :class="{ moving: row.moving, dimmed: !row.moving }"
            >
              <el-tag
                v-if="row.moving"
                size="small"
                type="primary"
                effect="plain"
                class="moving-tag"
              >
                From {{ sourceName(row.card.column_id) }}
              </el-tag>
              <el-tag :type="priorityType(row.card.priority)" size="small" effect="dark">
                {{ row.card.priority }}
              </el-tag>
              <span class="preview-title">{{ row.card.title }}</span>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- Step 2: per-card success / failure results -->
    <div v-else class="results-section">
      <el-result
        :icon="failedCount === 0 ? 'success' : (successCount === 0 ? 'error' : 'warning')"
        :title="failedCount === 0
          ? 'All cards moved'
          : (successCount === 0 ? 'No cards moved' : `${successCount} moved, ${failedCount} failed`)"
        style="padding: 8px 0;"
      />
      <el-scrollbar max-height="260px">
        <ul class="results-list">
          <li
            v-for="r in results"
            :key="r.cardId"
            class="result-row"
            :class="r.success ? 'is-success' : 'is-fail'"
          >
            <el-icon v-if="r.success" class="result-icon success"><CircleCheckFilled /></el-icon>
            <el-icon v-else class="result-icon fail"><CircleCloseFilled /></el-icon>
            <div class="result-body">
              <span class="result-title">{{ cardTitle(r.cardId) }}</span>
              <span class="result-detail">
                <template v-if="r.success">
                  Moved to {{ targetName(r.card?.column_id) }} · position
                  {{ (r.card?.position ?? 0) + 1 }}
                </template>
                <template v-else>{{ r.error }}</template>
              </span>
            </div>
          </li>
        </ul>
      </el-scrollbar>
    </div>

    <template #footer>
      <el-button @click="$emit('update:visible', false)">
        {{ results ? 'Close' : 'Cancel' }}
      </el-button>
      <el-button
        v-if="!results"
        type="primary"
        :disabled="!canSubmit || submitting"
        :loading="submitting"
        @click="submit"
      >
        Move {{ selectedCards.length }} card(s)
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { Top, CircleCheckFilled, CircleCloseFilled } from '@element-plus/icons-vue'
import { useBoardStore } from '../stores/board.js'
import { simulateBatchMove } from '../utils/batchMove.js'

const props = defineProps({
  visible: Boolean,
  allColumns: { type: Array, default: () => [] }
})

const emit = defineEmits(['update:visible', 'moved'])

const boardStore = useBoardStore()

const targetColumnId = ref(null)
const landingPosition = ref(0)
const submitting = ref(false)
const results = ref(null)

function resetState() {
  targetColumnId.value = props.allColumns.length ? props.allColumns[0].id : null
  landingPosition.value = 0
  submitting.value = false
  results.value = null
}

// Selected cards in current board order (column order, then card position).
const selectedCards = computed(() => {
  const set = new Set(boardStore.selectedCardIds)
  const found = []
  for (const col of props.allColumns) {
    for (const card of boardStore.cards[col.id] || []) {
      if (set.has(card.id)) found.push(card)
    }
  }
  return found
})

const moves = computed(() =>
  selectedCards.value.map(card => ({
    cardId: card.id,
    columnId: targetColumnId.value,
    position: landingPosition.value
  }))
)

// Simulated layout of the target column after the move.
const simulation = computed(() => {
  if (targetColumnId.value === null) return { byColumn: {}, inserted: [] }
  return simulateBatchMove(props.allColumns, boardStore.cards, moves.value)
})

const previewRows = computed(() => {
  if (targetColumnId.value === null) return []
  const list = simulation.value.byColumn[targetColumnId.value] || []
  const movingIds = new Set(moves.value.map(m => m.cardId))
  const rows = [{ key: 'gap-0', type: 'gap' }]
  list.forEach((card, i) => {
    rows.push({
      key: `card-${card.id}`,
      type: 'card',
      card,
      moving: movingIds.has(card.id)
    })
    rows.push({ key: `gap-${i + 1}`, type: 'gap' })
  })
  return rows
})

const successCount = computed(() => (results.value || []).filter(r => r.success).length)
const failedCount = computed(() => (results.value || []).filter(r => !r.success).length)

const canSubmit = computed(() =>
  targetColumnId.value !== null && selectedCards.value.length > 0
)

function sourceName(columnId) {
  return props.allColumns.find(c => c.id === columnId)?.name || 'unknown column'
}

function targetName(columnId) {
  return props.allColumns.find(c => c.id === columnId)?.name || 'unknown column'
}

function cardTitle(cardId) {
  for (const colId in boardStore.cards) {
    const c = boardStore.cards[colId].find(card => card.id === cardId)
    if (c) return c.title
  }
  return `#${cardId}`
}

function priorityType(priority) {
  switch (priority) {
    case 'high': return 'danger'
    case 'medium': return 'warning'
    case 'low': return 'success'
    default: return 'info'
  }
}

async function submit() {
  if (!canSubmit.value || submitting.value) return
  submitting.value = true
  try {
    const res = await boardStore.moveCards(moves.value.map(m => ({ ...m })))
    results.value = res
    // Selection only survives for cards whose move failed; successful cards
    // are deselected so they cannot be re-shown/resent on re-entering dialog.
    const failedIds = res.filter(r => !r.success).map(r => r.cardId)
    boardStore.setSelected(failedIds)
    emit('moved', res)
  } catch (err) {
    ElMessage.error('Failed to move cards')
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.selection-summary {
  margin-bottom: 16px;
}

.preview-hint {
  font-size: 12px;
  color: #909399;
  margin: 0 0 8px;
}

.preview-list {
  border: 1px solid #e4e7ed;
  border-radius: 6px;
  padding: 4px 10px;
  background: #fafafa;
}

.drop-gap {
  height: 14px;
  display: flex;
  align-items: center;
  cursor: pointer;
  border-radius: 4px;
}

.drop-gap:hover,
.drop-gap.active {
  background: #ecf5ff;
}

.preview-list.busy .drop-gap {
  pointer-events: none;
}

.gap-line {
  flex: 1;
  height: 2px;
  background: transparent;
  border-radius: 1px;
}

.drop-gap:hover .gap-line,
.drop-gap.active .gap-line {
  background: #409eff;
}

.gap-icon {
  color: #409eff;
}

.preview-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  background: #fff;
  border: 1px solid #ebeef5;
}

.preview-card.moving {
  border-color: #409eff;
  background: #ecf5ff;
}

.preview-card.dimmed {
  opacity: 0.65;
}

.moving-tag {
  margin-right: 0;
}

.preview-title {
  font-size: 13px;
  color: #303133;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.results-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.result-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 6px;
  margin-bottom: 6px;
  background: #fafafa;
}

.result-row.is-success {
  background: #f0f9eb;
}

.result-row.is-fail {
  background: #fef0f0;
}

.result-icon {
  font-size: 18px;
}

.result-icon.success {
  color: #67c23a;
}

.result-icon.fail {
  color: #f56c6c;
}

.result-body {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.result-title {
  font-size: 13px;
  font-weight: 500;
  color: #303133;
}

.result-detail {
  font-size: 12px;
  color: #909399;
}
</style>
