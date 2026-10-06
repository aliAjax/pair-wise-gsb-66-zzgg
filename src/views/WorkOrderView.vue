<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useTrackStore } from '../stores/track'
import { offlineKindLabels, offlineStatusColor, offlineStatusLabels } from '../utils/offlineQueue'
import type { RectificationAction, RetestResult } from '../types'

const route = useRoute()
const store = useTrackStore()
const selectedId = ref(String(route.params.id || store.defects[0]?.id || ''))
const defect = computed(() => store.defects.find((item) => item.id === selectedId.value))
const action = reactive({ method: '捣固', note: '', operator: '李海' })
const retest = reactive({ measuredValue: 0, tester: '王磊', note: '' })
const closureNote = ref('')
const message = ref('')
const defectQueue = computed(() => store.offlineQueue
  .filter((item) => item.defectId === selectedId.value)
  .sort((a, b) => b.enqueuedAt.localeCompare(a.enqueuedAt)))

async function addAction() {
  if (!defect.value || !action.note) return
  const payload: RectificationAction = { ...action, method: action.method as RectificationAction['method'], recordedAt: new Date().toISOString() }
  if (store.online) {
    store.addAction(defect.value.id, payload)
    message.value = '整治记录已提交'
  } else {
    await store.enqueueOffline('rectification', defect.value.id, payload, action.operator, payload.recordedAt)
    message.value = '断网中：整治记录已保存在本机队列，网络恢复后按现场时间合并'
  }
  action.note = ''
}
async function addRetest() {
  if (!defect.value) return
  const round = store.nextRetestRound(defect.value.id)
  const passed = retest.measuredValue <= defect.value.limit
  const payload: RetestResult = { round, passed, measuredValue: retest.measuredValue, limit: defect.value.limit, note: retest.note || (passed ? '复测合格' : '仍超过限值'), tester: retest.tester, testedAt: new Date().toISOString() }
  if (store.online) {
    store.addRetest(defect.value.id, payload)
    message.value = passed ? '复测通过，缺陷已关闭' : '复测不合格，任务重新进入整治'
  } else {
    await store.enqueueOffline('retest', defect.value.id, payload, retest.tester, payload.testedAt)
    message.value = `断网中：第${round}轮复测已保存在本机队列，同编号复测合并时保留先到记录`
  }
}
async function closeDefect() {
  if (!defect.value) return
  if (store.online) {
    const result = store.transition(defect.value.id, '已关闭')
    message.value = result.message
  } else {
    await store.enqueueOffline('closure', defect.value.id, { note: closureNote.value || '现场确认关闭' }, action.operator, new Date().toISOString())
    message.value = '断网中：关闭确认已保存在本机队列，合并时校验关闭条件'
  }
}
async function mergeNow() {
  const summary = await store.mergeOfflineQueue()
  message.value = `合并完成：已合并${summary.merged}条，待处理${summary.held}条，冲突${summary.conflict}条`
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
        <div class="offline-band" :class="{ offline: !store.online }">
          <strong>{{ store.online ? '在线模式' : '离线补录模式' }}</strong>
          <span>{{ store.online ? '提交直接生效；断网时补录写入本机队列，恢复后按现场记录时间合并。' : '整治、复测、关闭确认先写入本机队列，重开浏览器不丢失。' }}</span>
          <div class="band-actions">
            <v-btn v-if="store.pendingQueueCount" size="small" color="primary" :disabled="!store.online || store.merging" @click="mergeNow">{{ store.merging ? '合并中…' : `立即合并（${store.pendingQueueCount}）` }}</v-btn>
            <v-btn size="small" variant="text" @click="store.setOnline(!store.online)">{{ store.online ? '模拟断网' : '恢复网络' }}</v-btn>
          </div>
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
        <div class="action-form close-form">
          <v-text-field v-model="closureNote" label="关闭确认说明" density="compact" variant="outlined" hide-details />
          <v-btn variant="outlined" @click="closeDefect">申请关闭缺陷</v-btn>
        </div>
        <div v-if="message" class="validation-message">{{ message }}</div>
        <div v-if="defectQueue.length" class="queue-panel">
          <h3>本机补录队列</h3>
          <div v-for="item in defectQueue" :key="item.eventId" class="record-item queue-item">
            <div><strong>{{ offlineKindLabels[item.kind] }}</strong><v-chip size="x-small" :color="offlineStatusColor(item.status)">{{ offlineStatusLabels[item.status] }}</v-chip></div>
            <span>{{ item.statusNote || item.eventId }}</span>
            <small>{{ item.operator }} · 现场 {{ item.recordedAt.replace('T', ' ').slice(0, 16) }}</small>
          </div>
        </div>
        <div class="two-column">
          <div><h3>整治记录</h3><div v-for="item in defect.actions" :key="item.recordedAt" class="record-item"><strong>{{ item.method }}</strong><span>{{ item.note }}</span><small>{{ item.operator }} · {{ item.recordedAt.replace('T', ' ').slice(0, 16) }}</small></div></div>
          <div><h3>复测轮次</h3><div v-for="item in defect.retests" :key="item.round" class="record-item"><strong>第{{ item.round }}轮 {{ item.passed ? '通过' : '未通过' }}</strong><span>{{ item.measuredValue }} / {{ item.limit }}</span><small>{{ item.tester }} · {{ item.note }}</small></div></div>
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
.offline-band { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 11px; border-left: 3px solid #315b72; background: #eef4f6; font-size: 12px; }.offline-band span { color: #5d6d6b; flex: 1; }
.offline-band.offline { border-left-color: #b08735; background: #fbf6e9; }.offline-band.offline span { color: #736d5b; }
.band-actions { display: flex; gap: 6px; align-items: center; }
.action-form { display: grid; grid-template-columns: 170px 1fr 140px auto; gap: 10px; margin: 13px 0; }
.action-form.close-form { grid-template-columns: 1fr auto; }
.validation-message { color: #a63e38; font-size: 12px; margin-bottom: 10px; }
.queue-panel { margin: 6px 0 4px; }.queue-panel h3 { font-size: 14px; margin-bottom: 4px; }
.queue-item > div { display: flex; align-items: center; gap: 8px; }
.two-column { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 18px 0; }.two-column h3 { font-size: 14px; }
.record-item { border-top: 1px solid #e2e7e7; padding: 10px 0; display: grid; gap: 4px; }.record-item span, .record-item small { color: #6d7b79; font-size: 11px; }
</style>
