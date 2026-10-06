<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTrackStore } from '../stores/track'
import type { AuditTag } from '../types'

const store = useTrackStore()
const keyword = ref('')
const category = ref<'全部' | AuditTag>('全部')
const rows = computed(() => store.audit.filter((item) => {
  const text = `${item.entityId} ${item.action} ${item.operator} ${item.detail}`
  return text.includes(keyword.value) && (category.value === '全部' || item.tag === category.value)
}))
const supplementSummary = computed(() => {
  const summary: Record<string, number> = { 待同步: 0, 已合并: 0, 待处理: 0, 冲突: 0 }
  for (const item of store.supplements) summary[item.status] = (summary[item.status] ?? 0) + 1
  return summary
})
function tagColor(tag?: AuditTag) {
  return tag === '已合并' ? 'success' : tag === '待处理' ? 'warning' : tag === '冲突' ? 'error' : 'grey'
}
function exportReport() {
  const payload = { generatedAt: new Date().toISOString(), segments: store.segments, defects: store.defects, audit: store.audit, supplements: store.supplements, supplementSummary: supplementSummary.value }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = '轨道几何整治报告.json'; anchor.click(); URL.revokeObjectURL(url)
}
</script>

<template>
  <section class="page audit-page">
    <div class="section-head"><div><h2>整治审计与版本追溯</h2><p>检测数据、批量派工、限速调整、离线补录和复测轮次全部留痕。</p><p class="queue-summary">补录队列：待同步 {{ supplementSummary['待同步'] }} · 已合并 {{ supplementSummary['已合并'] }} · 待处理 {{ supplementSummary['待处理'] }} · 冲突 {{ supplementSummary['冲突'] }}</p></div><v-btn color="primary" @click="exportReport">导出整治报告</v-btn></div>
    <div class="toolbar single">
      <v-text-field v-model="keyword" density="compact" variant="outlined" hide-details prepend-inner-icon="mdi-magnify" placeholder="搜索实体、动作、操作人或说明" />
      <v-chip-group v-model="category" mandatory>
        <v-chip value="全部" filter variant="outlined" size="small">全部</v-chip>
        <v-chip value="已合并" filter variant="outlined" size="small">已合并</v-chip>
        <v-chip value="待处理" filter variant="outlined" size="small">待处理</v-chip>
        <v-chip value="冲突" filter variant="outlined" size="small">冲突</v-chip>
      </v-chip-group>
      <span>共{{ rows.length }}条</span>
    </div>
    <v-table density="compact">
      <thead><tr><th>时间</th><th>实体</th><th>动作</th><th>类别</th><th>操作人</th><th>说明</th></tr></thead>
      <tbody><tr v-for="item in rows" :key="item.id"><td>{{ item.createdAt.replace('T', ' ').slice(0, 16) }}</td><td>{{ item.entityId }}</td><td>{{ item.action }}</td><td><v-chip v-if="item.tag" size="x-small" :color="tagColor(item.tag)">{{ item.tag }}</v-chip><span v-else>—</span></td><td>{{ item.operator }}</td><td>{{ item.detail }}</td></tr></tbody>
    </v-table>
  </section>
</template>

<style scoped>
.audit-page :deep(.v-table) { background: white; border: 1px solid #dae1e2; }
.section-head { display: flex; justify-content: space-between; margin-bottom: 14px; }.section-head h2 { margin: 0 0 5px; font-size: 19px; }.section-head p { margin: 0; color: #71807e; font-size: 12px; }
.queue-summary { margin-top: 4px !important; color: #8a6d2f !important; }
.toolbar.single { display: grid; grid-template-columns: 420px 1fr auto; gap: 12px; margin-bottom: 10px; align-items: center; }.toolbar.single span { align-self: center; color: #71807e; font-size: 11px; }
</style>
