<template>
  <el-card
    class="task-card"
    :class="{ selected: isSelected, 'select-mode': selectionMode }"
    shadow="hover"
    @click="handleCardClick"
  >
    <div class="task-card-content">
      <div class="task-card-top">
        <el-checkbox
          v-if="selectionMode"
          :model-value="isSelected"
          class="select-checkbox"
          @change="$emit('toggle-select', card.id)"
          @click.stop
        />
        <el-tag v-else :type="priorityType" size="small" effect="dark" class="priority-tag">
          {{ card.priority }}
        </el-tag>
        <el-dropdown trigger="click" @command="handleCommand" @click.stop>
          <el-button text size="small" :icon="MoreFilled" @click.stop />
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="edit">Edit Details</el-dropdown-item>
              <el-dropdown-item v-if="otherColumns.length > 0" command="move">
                Move to...
              </el-dropdown-item>
              <el-dropdown-item command="delete" divided>
                Delete
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>

      <h4 class="task-title">{{ card.title }}</h4>

      <p v-if="card.description" class="task-desc">{{ card.description }}</p>

      <div v-if="card.due_date" class="task-due">
        <el-icon><Calendar /></el-icon>
        <span :class="{ overdue: isOverdue }">{{ formatDate(card.due_date) }}</span>
      </div>
    </div>

    <!-- Move submenu -->
    <el-dialog v-model="showMoveDialog" title="Move to Column" width="320px" append-to-body :close-on-click-modal="false">
      <el-select v-model="targetColumnId" placeholder="Select target column" style="width: 100%">
        <el-option
          v-for="col in otherColumns"
          :key="col.id"
          :label="col.name"
          :value="col.id"
        />
      </el-select>
      <template #footer>
        <el-button @click="showMoveDialog = false">Cancel</el-button>
        <el-button type="primary" :disabled="!targetColumnId" @click="confirmMove">Move</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup>
import { ref, computed } from 'vue'
import { MoreFilled, Calendar } from '@element-plus/icons-vue'

const props = defineProps({
  card: { type: Object, required: true },
  allColumns: { type: Array, default: () => [] },
  selectionMode: { type: Boolean, default: false },
  isSelected: { type: Boolean, default: false }
})

const emit = defineEmits(['edit', 'delete', 'move', 'toggle-select', 'card-drag-start'])

const showMoveDialog = ref(false)
const targetColumnId = ref(null)

const priorityType = computed(() => {
  switch (props.card.priority) {
    case 'high': return 'danger'
    case 'medium': return 'warning'
    case 'low': return 'success'
    default: return 'info'
  }
})

const isOverdue = computed(() => {
  if (!props.card.due_date) return false
  return new Date(props.card.due_date) < new Date()
})

const otherColumns = computed(() => {
  return props.allColumns.filter(c => c.id !== props.card.column_id)
})

function formatDate(dateStr) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function handleCardClick() {
  if (props.selectionMode) {
    emit('toggle-select', props.card.id)
  } else {
    emit('edit', props.card)
  }
}

function handleCommand(command) {
  if (command === 'edit') {
    emit('edit', props.card)
  } else if (command === 'delete') {
    emit('delete', props.card)
  } else if (command === 'move') {
    targetColumnId.value = null
    showMoveDialog.value = true
  }
}

function confirmMove() {
  if (targetColumnId.value) {
    emit('move', targetColumnId.value)
    showMoveDialog.value = false
  }
}
</script>

<style scoped>
.task-card {
  margin-bottom: 8px;
  cursor: pointer;
  transition: transform 0.15s, border-color 0.15s;
}

.task-card:hover {
  transform: translateY(-2px);
}

.task-card.selected {
  border-color: #409eff;
  box-shadow: 0 0 0 1px #409eff;
}

.task-card.select-mode :deep(.el-card__body) {
  padding-top: 10px;
  padding-bottom: 10px;
}

.task-card :deep(.el-card__body) {
  padding: 12px;
}

.task-card-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.select-checkbox {
  margin-right: auto;
}

.priority-tag {
  text-transform: capitalize;
}

.task-title {
  font-size: 14px;
  color: #303133;
  margin: 0 0 6px;
  line-height: 1.4;
}

.task-desc {
  font-size: 12px;
  color: #909399;
  margin: 0 0 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-due {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #909399;
}

.task-due .overdue {
  color: #f56c6c;
  font-weight: 500;
}
</style>
