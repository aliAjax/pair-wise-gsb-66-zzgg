<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTrackStore } from '../stores/track'
import { offlineKindLabels, offlineStatusColor, offlineStatusLabels } from '../utils/offlineQueue'
import type { AuditCategory } from '../types'

const store = useTrackStore()
const keyword = ref('')
const category = ref<'全部' | '常规' | AuditCategory>('全部')
const categories: Array<'全部' | '常规' | AuditCategory> = ['全部', '常规', '已合并', '待处理', '冲突']
const mergeMessage = ref('')
const rows = computed(() => store.audit.filter((item) => {
  const matchCategory = category.value === '全部' || (category.value === '常规' ? !item.category : item.category === category.value)
  return matchCategory && `${item.entityId} ${item.action} ${item.operator} ${item.detail}`.includes(keyword.value)
}))
const queueRows = computed(() => [...store.offlineQueue].sort((a, b) => b.enqueuedAt.localeCompare(a.enqueuedAt)))
function categoryColor(value?: AuditCategory): string {
  return value === '已合并' ? 'success' : value === '待处理' ? 'warning' : value === '冲突' ? 'error' : 'default'
}
async function mergeNow() {
  const summary = await store.mergeOfflineQueue()
  mergeMessage.value = `合并完成：已合并${summary.merged}条，待处理${summary.held}条，冲突${summary.conflict}条`
}
function exportReport() {
  const queue = store.offlineQueue
  const payload = {
    generatedAt: new Date().toISOString(),
    segments: store.segments,
    defects: store.defects,
    audit: store.audit,
    offlineSupplement: {
      merged: queue.filter((item) => item.status === 'merged'),
      held: queue.filter((item) => item.status === 'held'),
      conflict: queue.filter((item) => item.status === 'conflict'),
      pending: queue.filter((item) => item.status === 'pending')
    }
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = '轨道几何整治报告.json'; anchor.click(); URL.revokeObjectURL(url)
}
</script>

<template>
  <section class="page audit-page">
    <div class="section-head"><div><h2>整治审计与版本追溯</h2><p>检测数据、批量派工、限速调整、离线补录和复测轮次全部留痕，补录按已合并 / 待处理 / 冲突分类。</p></div><v-btn color="primary" @click="exportReport">导出整治报告</v-btn></div>
    <div class="toolbar single"><v-text-field v-model="keyword" density="compact" variant="outlined" hide-details prepend-inner-icon="mdi-magnify" placeholder="搜索实体、动作、操作人或说明" /><v-select v-model="category" :items="categories" label="补录类别" density="compact" variant="outlined" hide-details /><span>共{{ rows.length }}条</span></div>
    <v-table density="compact">
      <thead><tr><th>时间</th><th>实体</th><th>动作</th><th>操作人</th><th>类别</th><th>说明</th></tr></thead>
      <tbody><tr v-for="item in rows" :key="item.id"><td>{{ item.createdAt.replace('T', ' ').slice(0, 16) }}</td><td>{{ item.entityId }}</td><td>{{ item.action }}</td><td>{{ item.operator }}</td><td><v-chip v-if="item.category" size="x-small" :color="categoryColor(item.category)">{{ item.category }}</v-chip><span v-else>—</span></td><td>{{ item.detail }}</td></tr></tbody>
    </v-table>
    <div class="section-head queue-head"><div><h2>离线补录队列</h2><p>断网期间的整治、复测和关闭确认留在本机，网络恢复后按现场记录时间合并，每个补录事件只生效一次。</p></div><v-btn color="secondary" :disabled="!store.online || !store.pendingQueueCount || store.merging" @click="mergeNow">{{ store.merging ? '合并中…' : `合并补录队列（${store.pendingQueueCount}）` }}</v-btn></div>
    <div v-if="mergeMessage" class="merge-message">{{ mergeMessage }}</div>
    <v-table density="compact">
      <thead><tr><th>事件编号</th><th>缺陷</th><th>类型</th><th>现场时间</th><th>操作人</th><th>状态</th><th>说明</th></tr></thead>
      <tbody>
        <tr v-for="item in queueRows" :key="item.eventId"><td>{{ item.eventId }}</td><td>{{ item.defectId }}</td><td>{{ offlineKindLabels[item.kind] }}</td><td>{{ item.recordedAt.replace('T', ' ').slice(0, 16) }}</td><td>{{ item.operator }}</td><td><v-chip size="x-small" :color="offlineStatusColor(item.status)">{{ offlineStatusLabels[item.status] }}</v-chip></td><td>{{ item.statusNote || '—' }}</td></tr>
        <tr v-if="!queueRows.length"><td colspan="7" class="empty">暂无补录记录，断网时提交的整治、复测和关闭确认会保留在这里</td></tr>
      </tbody>
    </v-table>
  </section>
</template>

<style scoped>
.audit-page :deep(.v-table) { background: white; border: 1px solid #dae1e2; }
.section-head { display: flex; justify-content: space-between; margin-bottom: 14px; }.section-head h2 { margin: 0 0 5px; font-size: 19px; }.section-head p { margin: 0; color: #71807e; font-size: 12px; }
.section-head.queue-head { margin-top: 22px; }
.toolbar.single { display: grid; grid-template-columns: 1fr 160px auto; gap: 12px; margin-bottom: 10px; }.toolbar.single span { align-self: center; color: #71807e; font-size: 11px; }
.merge-message { color: #315b72; font-size: 12px; margin-bottom: 8px; }
.empty { color: #71807e; font-size: 12px; text-align: center; }
</style>
