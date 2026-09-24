<template>
  <el-dialog
    :model-value="visible"
    title="Batch Move Results"
    width="520px"
    :close-on-click-modal="false"
    @update:model-value="$emit('update:visible', $event)"
  >
    <el-result
      v-if="allSucceeded"
      icon="success"
      :title="`All ${results.length} card(s) moved`"
      :sub-title="targetColumnName ? `to “${targetColumnName}”.` : ''"
    />
    <el-result
      v-else-if="noneSucceeded"
      icon="error"
      title="No cards were moved"
      sub-title="See the details below."
    />
    <el-result
      v-else
      icon="warning"
      :title="`${succeededCount} moved, ${failedCount} failed`"
      sub-title="Card positions reflect successful moves only."
    />

    <el-scrollbar max-height="240px" class="results-scroll">
      <ul class="results-list">
        <li v-for="item in rows" :key="item.card_id" class="result-row">
          <el-icon v-if="item.success" class="result-ok"><CircleCheckFilled /></el-icon>
          <el-icon v-else class="result-fail"><CircleCloseFilled /></el-icon>
          <span class="result-title">{{ item.title }}</span>
          <el-tag v-if="item.success" type="success" size="small">Moved</el-tag>
          <el-tooltip v-else :content="friendlyError(item.error)" placement="top">
            <el-tag type="danger" size="small">Failed</el-tag>
          </el-tooltip>
        </li>
      </ul>
    </el-scrollbar>

    <template #footer>
      <el-button v-if="failedCount > 0 && retryableFailed.length > 0" @click="$emit('retry', retryableFailed)">
        Retry failed ({{ retryableFailed.length }})
      </el-button>
      <el-button type="primary" @click="$emit('update:visible', false)">Done</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed } from 'vue'
import { CircleCheckFilled, CircleCloseFilled } from '@element-plus/icons-vue'

const props = defineProps({
  visible: Boolean,
  // response payload from POST /api/cards/batch-move
  response: { type: Object, default: null },
  // cardId -> card object, used to show titles even when the server omits them
  cardLookup: { type: Object, default: () => ({}) },
  targetColumnName: { type: String, default: '' }
})

defineEmits(['update:visible', 'retry'])

const results = computed(() => props.response?.results || [])
const succeededCount = computed(() => results.value.filter(r => r.success).length)
const failedCount = computed(() => results.value.length - succeededCount.value)
const allSucceeded = computed(() => results.value.length > 0 && failedCount.value === 0)
const noneSucceeded = computed(() => succeededCount.value === 0)

const rows = computed(() => results.value.map(r => ({
  ...r,
  title: r.card?.title || props.cardLookup[r.card_id]?.title || `Card #${r.card_id}`
})))

// "Retry" only makes sense for cards still present locally (e.g. not 404).
const retryableFailed = computed(() =>
  results.value.filter(r => !r.success && props.cardLookup[r.card_id]).map(r => r.card_id)
)

function friendlyError(error) {
  if (!error) return 'Move failed'
  if (error.includes('Target column not found')) return 'Target column no longer exists'
  if (error.includes('same board')) return 'Card is on a different board'
  if (error.includes('Card not found')) return 'Card no longer exists'
  return error
}
</script>

<style scoped>
.results-scroll {
  margin-top: 8px;
  border: 1px solid #ebeef5;
  border-radius: 6px;
}

.results-list {
  list-style: none;
  margin: 0;
  padding: 8px 12px;
}

.result-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid #f2f6fc;
}

.result-row:last-child {
  border-bottom: none;
}

.result-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: #303133;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.result-ok {
  color: #67c23a;
  font-size: 16px;
  flex-shrink: 0;
}

.result-fail {
  color: #f56c6c;
  font-size: 16px;
  flex-shrink: 0;
}
</style>
