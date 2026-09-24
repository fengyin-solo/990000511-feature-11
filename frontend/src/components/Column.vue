<template>
  <div class="column" :class="{ 'drop-target': isDropTarget }">
    <div class="column-header">
      <div v-if="!isEditing" class="column-title" @dblclick="startEditing">
        <h3>{{ column.name }}</h3>
        <el-tag size="small" round>{{ cards.length }}</el-tag>
      </div>
      <div v-else class="column-edit">
        <el-input
          ref="editInputRef"
          v-model="editName"
          size="small"
          @keyup.enter="saveRename"
          @blur="saveRename"
        />
      </div>
      <el-dropdown trigger="click" @command="handleCommand">
        <el-button text size="small" :icon="MoreFilled" />
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="rename">Rename</el-dropdown-item>
            <el-dropdown-item command="delete" divided>Delete Column</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>

    <div class="column-cards">
      <!-- :key includes renderKey so after a drag (Sortable has mutated the DOM
           by hand) the list is fully rebuilt from store state, which makes a
           duplicated/stray drag node impossible. -->
      <draggable
        :key="`cards-${column.id}-${renderKey}`"
        :model-value="cards"
        item-key="id"
        group="cards"
        ghost-class="card-ghost"
        animation="200"
        :disabled="isMoving"
        :data-col-id="column.id"
        :move="onCardDragMove"
        @start="onCardDragStart"
        @end="onCardDragEnd"
      >
        <template #item="{ element: card }">
          <TaskCard
            :card="card"
            :all-columns="allColumns"
            :selection-mode="selectionMode"
            :is-selected="selectedIds.has(card.id)"
            @edit="$emit('edit-card', card)"
            @delete="$emit('delete-card', card)"
            @move="(targetColId) => $emit('move-card', card.id, targetColId, 0)"
            @toggle-select="$emit('toggle-select', $event)"
          />
        </template>
      </draggable>
    </div>

    <div class="column-footer">
      <el-button text type="primary" :icon="Plus" @click="$emit('add-card', column.id)">
        Add Card
      </el-button>
    </div>
  </div>
</template>

<script setup>
import { ref, nextTick } from 'vue'
import { MoreFilled, Plus } from '@element-plus/icons-vue'
import draggable from 'vuedraggable'
import TaskCard from './TaskCard.vue'

const props = defineProps({
  column: { type: Object, required: true },
  cards: { type: Array, default: () => [] },
  allColumns: { type: Array, default: () => [] },
  selectionMode: { type: Boolean, default: false },
  selectedIds: { type: Set, default: () => new Set() },
  isMoving: { type: Boolean, default: false },
  isDropTarget: { type: Boolean, default: false },
  renderKey: { type: Number, default: 0 }
})

const emit = defineEmits([
  'add-card', 'edit-card', 'delete-card', 'move-card',
  'rename-column', 'delete-column',
  'toggle-select', 'card-drag-start', 'card-drag-move', 'card-drag-end'
])

const isEditing = ref(false)
const editName = ref('')
const editInputRef = ref(null)

function startEditing() {
  editName.value = props.column.name
  isEditing.value = true
  nextTick(() => {
    editInputRef.value?.focus()
  })
}

function saveRename() {
  if (editName.value.trim() && editName.value.trim() !== props.column.name) {
    emit('rename-column', props.column.id, editName.value.trim())
  }
  isEditing.value = false
}

function handleCommand(command) {
  if (command === 'rename') {
    startEditing()
  } else if (command === 'delete') {
    emit('delete-column', props.column)
  }
}

function ctxId(el) {
  return el?.__draggable_context?.element?.id ?? null
}

// The board owns all move logic/state; the column only reports raw Sortable
// geometry so the board can preview and commit single or batch moves.
function onCardDragStart(evt) {
  emit('card-drag-start', {
    cardId: ctxId(evt.item),
    fromColumnId: props.column.id
  })
}

// vuedraggable invokes this as Sortable's onMove callback (it is a managed
// prop, not an emitted event). Returning undefined allows the move; we only
// use it to drive the drop preview.
function onCardDragMove(evt) {
  emit('card-drag-move', {
    toColumnId: Number(evt.to?.dataset?.colId) || props.column.id,
    relatedId: ctxId(evt.related)
  })
}

function onCardDragEnd(evt) {
  emit('card-drag-end', {
    cardId: ctxId(evt.item),
    fromColumnId: props.column.id,
    toColumnId: Number(evt.to?.dataset?.colId) || props.column.id,
    oldIndex: evt.oldIndex,
    newIndex: evt.newIndex,
    relatedId: ctxId(evt.related)
  })
}
</script>

<style scoped>
.column {
  width: 300px;
  min-width: 300px;
  background: #f4f5f7;
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 160px);
  transition: box-shadow 0.15s, outline-color 0.15s;
  outline: 2px solid transparent;
}

.column.drop-target {
  outline-color: #409eff;
  box-shadow: 0 0 12px rgba(64, 158, 255, 0.35);
}

.column-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 12px 8px;
}

.column-title {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  flex: 1;
  min-width: 0;
}

.column-title h3 {
  font-size: 15px;
  color: #303133;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.column-edit {
  flex: 1;
  margin-right: 8px;
}

.column-cards {
  flex: 1;
  overflow-y: auto;
  padding: 4px 8px;
  min-height: 60px;
}

.column-cards::-webkit-scrollbar {
  width: 6px;
}

.column-cards::-webkit-scrollbar-thumb {
  background: #c0c4cc;
  border-radius: 3px;
}

.column-footer {
  padding: 8px;
  border-top: 1px solid #e4e7ed;
}

.card-ghost {
  opacity: 0.5;
  background: #e8f4ff;
  border-radius: 6px;
}
</style>
