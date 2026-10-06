<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useTrackStore } from '../stores/track'
import type { SupplementStatus } from '../types'

const route = useRoute()
const store = useTrackStore()
const selectedId = ref(String(route.params.id || store.defects[0]?.id || ''))
const defect = computed(() => store.defects.find((item) => item.id === selectedId.value))
const action = reactive({ method: '捣固', note: '', operator: '李海' })
const retest = reactive({ measuredValue: 0, tester: '王磊', note: '' })
const message = ref('')
const queueRows = computed(() => store.supplements.slice().sort((a, b) => b.createdAt.localeCompare(b.createdAt)))
function statusColor(value: SupplementStatus) {
  return value === '已合并' ? 'success' : value === '待处理' ? 'warning' : value === '冲突' ? 'error' : 'info'
}
function addAction() {
  if (!defect.value || !action.note) return
  const result = store.addAction(defect.value.id, { ...action, method: action.method as any, recordedAt: new Date().toISOString() })
  message.value = result.message
  if (result.ok) action.note = ''
}
function addRetest() {
  if (!defect.value) return
  const round = defect.value.retests.length + 1
  const passed = retest.measuredValue <= defect.value.limit
  const result = store.addRetest(defect.value.id, { round, passed, measuredValue: retest.measuredValue, limit: defect.value.limit, note: retest.note || (passed ? '复测合格' : '仍超过限值'), tester: retest.tester, testedAt: new Date().toISOString() })
  message.value = result.message
}
function closeDefect() {
  if (!defect.value) return
  const result = store.transition(defect.value.id, '已关闭')
  message.value = result.message
}
function syncNow() {
  const summary = store.mergeSupplements()
  message.value = `同步完成：已合并${summary.merged}条，待处理${summary.pending}条，冲突${summary.conflict}条${summary.skipped ? `，${summary.skipped}条已被其他窗口处理` : ''}`
}
function resolveEvent(id: string, decision: 'append' | 'discard') {
  const result = store.resolveSupplement(id, decision)
  message.value = result.message
}
</script>

<template>
  <section class="page">
    <div class="work-layout">
      <div class="work-list">
        <button v-for="item in store.defects" :key="item.id" :class="{ active: item.id === selectedId }" @click="selectedId = item.id">
          <span>{{ item.id }} · V{{ item.version }}</span><strong>{{ item.type }}超限</strong><small>{{ item.owner }} · {{ item.status }}</small>
        </button>
      </div>
      <div v-if="defect" class="work-main">
        <div class="section-head"><div><span>{{ defect.segmentId }} · K{{ Math.floor(defect.mileage / 1000) }}+{{ String(defect.mileage % 1000).padStart(3, '0') }}</span><h2>{{ defect.type }}缺陷整治</h2><p>{{ defect.measuredValue }} / 限值 {{ defect.limit }} · {{ defect.severity }} · {{ defect.status }}</p></div><v-chip :color="defect.status === '已关闭' ? 'success' : 'warning'">{{ defect.status }}</v-chip></div>
        <div class="offline-band">
          <strong>离线补录模式</strong>
          <span>断网时整治、复测和关闭确认先写入本地队列，恢复后按现场记录时间合并，重开浏览器队列不丢。</span>
          <v-switch v-model="store.offlineSwitch" label="模拟离线" density="compact" hide-details color="warning" />
          <v-chip size="small" :color="store.isOffline ? 'warning' : 'success'">{{ store.isOffline ? '离线中' : '在线' }}</v-chip>
          <v-btn size="small" color="primary" :disabled="store.isOffline || !store.pendingCount" @click="syncNow">立即同步（{{ store.pendingCount }}）</v-btn>
        </div>
        <div class="action-form">
          <v-select v-model="action.method" :items="['打磨', '捣固', '更换', '垫板调整', '测量复核']" label="整治方式" density="compact" variant="outlined" hide-details />
          <v-text-field v-model="action.note" label="现场记录" density="compact" variant="outlined" hide-details />
          <v-text-field v-model="action.operator" label="操作人" density="compact" variant="outlined" hide-details />
          <v-btn color="primary" :disabled="!action.note" @click="addAction">提交整治记录</v-btn>
        </div>
        <div class="action-form">
          <v-text-field v-model.number="retest.measuredValue" type="number" label="复测值" density="compact" variant="outlined" hide-details />
          <v-text-field v-model="retest.tester" label="复测人" density="compact" variant="outlined" hide-details />
          <v-text-field v-model="retest.note" label="复测说明" density="compact" variant="outlined" hide-details />
          <v-btn color="secondary" @click="addRetest">提交复测</v-btn>
        </div>
        <div v-if="message" class="validation-message">{{ message }}</div>
        <div class="two-column">
          <div><h3>整治记录</h3><div v-for="item in defect.actions" :key="item.recordedAt" class="record-item"><strong>{{ item.method }}</strong><span>{{ item.note }}</span><small>{{ item.operator }} · {{ item.recordedAt.replace('T', ' ').slice(0, 16) }}</small></div></div>
          <div><h3>复测轮次</h3><div v-for="item in defect.retests" :key="item.round" class="record-item"><strong>第{{ item.round }}轮 {{ item.passed ? '通过' : '未通过' }}</strong><span>{{ item.measuredValue }} / {{ item.limit }}</span><small>{{ item.tester }} · {{ item.note }}</small></div></div>
        </div>
        <v-btn variant="outlined" @click="closeDefect">申请关闭缺陷</v-btn>
        <div class="queue-panel">
          <h3>本地补录队列<small v-if="queueRows.length">（{{ queueRows.length }}条，按现场记录时间合并）</small></h3>
          <p v-if="!queueRows.length" class="queue-empty">暂无补录记录。开启“模拟离线”后提交的整治、复测和关闭确认会留在这里。</p>
          <div v-for="item in queueRows" :key="item.id" class="queue-item">
            <div class="queue-line">
              <v-chip size="x-small" :color="statusColor(item.status)">{{ item.status }}</v-chip>
              <strong>{{ item.kind }} · {{ item.defectId }}</strong>
              <span>现场 {{ item.recordedAt.replace('T', ' ').slice(0, 16) }} · {{ item.operator }} · 基准 缺陷V{{ item.baseDefectVersion }}/区段V{{ item.baseSegmentVersion }}</span>
            </div>
            <small v-if="item.reason" class="queue-reason">{{ item.reason }}</small>
            <div v-if="item.status === '待处理'" class="queue-actions">
              <v-btn size="x-small" variant="outlined" @click="resolveEvent(item.id, 'append')">追加为新轮次</v-btn>
              <v-btn size="x-small" variant="text" color="error" @click="resolveEvent(item.id, 'discard')">作废</v-btn>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.work-layout { display: grid; grid-template-columns: 300px 1fr; gap: 14px; align-items: start; }
.work-list { display: grid; gap: 8px; }
.work-list button { border: 1px solid #dae1e2; background: white; padding: 13px; text-align: left; display: grid; gap: 6px; cursor: pointer; }
.work-list button.active { border-color: #315b72; box-shadow: inset 3px 0 #315b72; }
.work-list span, .work-list small { color: #738180; font-size: 11px; }
.work-main { background: white; border: 1px solid #dae1e2; padding: 18px; }
.section-head { display: flex; justify-content: space-between; margin-bottom: 14px; }.section-head span { color: #71807e; font-size: 11px; }.section-head h2 { margin: 4px 0; }.section-head p { margin: 0; color: #667573; }
.offline-band { display: flex; align-items: center; gap: 12px; padding: 11px; border-left: 3px solid #b08735; background: #fbf6e9; font-size: 12px; }.offline-band span { color: #736d5b; flex: 1; }
.action-form { display: grid; grid-template-columns: 170px 1fr 140px auto; gap: 10px; margin: 13px 0; }
.validation-message { color: #a63e38; font-size: 12px; margin-bottom: 10px; }
.two-column { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 18px 0; }.two-column h3 { font-size: 14px; }
.record-item { border-top: 1px solid #e2e7e7; padding: 10px 0; display: grid; gap: 4px; }.record-item span, .record-item small { color: #6d7b79; font-size: 11px; }
.queue-panel { margin-top: 18px; border-top: 1px solid #e2e7e7; padding-top: 14px; }
.queue-panel h3 { font-size: 14px; margin-bottom: 8px; }.queue-panel h3 small { color: #738180; font-weight: normal; }
.queue-empty { color: #738180; font-size: 12px; margin: 0; }
.queue-item { border-top: 1px solid #eef1f1; padding: 8px 0; display: grid; gap: 4px; }
.queue-line { display: flex; align-items: center; gap: 8px; font-size: 12px; }.queue-line span { color: #738180; font-size: 11px; }
.queue-reason { color: #8a6d2f; font-size: 11px; }
.queue-actions { display: flex; gap: 8px; }
</style>
