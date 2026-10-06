import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { seedAudit, seedDefects, seedSegments } from '../data/seed'
import type { AuditEntry, AuditTag, Defect, DefectStatus, RectificationAction, RetestResult, SupplementEvent, SupplementKind, SupplementStatus, TrackSegment } from '../types'

const STORAGE_KEY = 'gsb66:track-geometry'
let idSeed = 10

interface MergeSummary {
  merged: number
  pending: number
  conflict: number
  skipped: number
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : { segments: seedSegments, defects: seedDefects, audit: seedAudit, supplements: [] }
  } catch {
    return { segments: seedSegments, defects: seedDefects, audit: seedAudit, supplements: [] }
  }
}

function readStoredSupplements(): SupplementEvent[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const data = raw ? JSON.parse(raw) : null
    return Array.isArray(data?.supplements) ? data.supplements : []
  } catch {
    return []
  }
}

export const useTrackStore = defineStore('track', () => {
  const initial = load()
  const segments = ref<TrackSegment[]>(initial.segments)
  const defects = ref<Defect[]>(initial.defects)
  const audit = ref<AuditEntry[]>(initial.audit)
  const supplements = ref<SupplementEvent[]>(initial.supplements ?? [])
  const keyword = ref('')
  const status = ref<DefectStatus | '全部'>('全部')
  const selectedSegmentId = ref(segments.value[0]?.id ?? '')
  const online = ref(typeof navigator === 'undefined' ? true : navigator.onLine !== false)
  const forceOffline = ref(false)
  const isOffline = computed(() => forceOffline.value || !online.value)
  const pendingCount = computed(() => supplements.value.filter((item) => item.status === '待同步').length)
  let merging = false

  // 网络恢复或关闭模拟离线时显式触发合并，不依赖 watch（同一周期内状态往返会被跳过）
  function setOnline(value: boolean) {
    online.value = value
    if (value && !forceOffline.value && pendingCount.value) mergeSupplements()
  }

  function setForceOffline(value: boolean) {
    forceOffline.value = value
    if (!value && online.value && pendingCount.value) mergeSupplements()
  }

  const offlineSwitch = computed({
    get: () => forceOffline.value,
    set: (value: boolean) => setForceOffline(value)
  })

  const filtered = computed(() => defects.value.filter((item) => {
    const segment = segments.value.find((value) => value.id === item.segmentId)
    const text = `${item.id} ${segment?.line ?? ''} ${item.type} ${item.owner}`.toLowerCase()
    return (!keyword.value || text.includes(keyword.value.toLowerCase())) && (status.value === '全部' || item.status === status.value)
  }))

  const selectedSegment = computed(() => segments.value.find((item) => item.id === selectedSegmentId.value))

  // 持久化时与存储中的队列做并集，避免本窗口的写入冲掉其他窗口已入队的补录
  function persist() {
    const stored = readStoredSupplements()
    const queue = supplements.value.map((event) => {
      const fresh = stored.find((item) => item.id === event.id)
      return event.status === '待同步' && fresh && fresh.status !== '待同步' ? fresh : event
    })
    for (const item of stored) {
      if (!queue.some((event) => event.id === item.id)) queue.push(item)
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ segments: segments.value, defects: defects.value, audit: audit.value, supplements: queue }))
  }

  // 并入其他窗口已持久化的补录事件：按事件编号去重，终态（已合并/待处理/冲突）不被回退
  function unionQueue(incoming: SupplementEvent[]) {
    for (const item of incoming) {
      const local = supplements.value.find((event) => event.id === item.id)
      if (!local) supplements.value.push(item)
      else if (local.status === '待同步' && item.status !== '待同步') Object.assign(local, item)
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => setOnline(true))
    window.addEventListener('offline', () => setOnline(false))
    window.addEventListener('storage', (event) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return
      try {
        const data = JSON.parse(event.newValue)
        segments.value = data.segments ?? segments.value
        defects.value = data.defects ?? defects.value
        audit.value = data.audit ?? audit.value
        unionQueue(Array.isArray(data.supplements) ? data.supplements : [])
      } catch { /* 忽略损坏的同步数据 */ }
    })
  }

  function assign(defectIds: string[], owner: string) {
    for (const id of defectIds) {
      const defect = defects.value.find((item) => item.id === id)
      if (!defect) continue
      defect.owner = owner
      defect.status = '整治中'
      defect.version += 1
      addAudit(id, '批量派工', '当前用户', `任务分配至${owner}`)
    }
  }

  function addAction(id: string, action: RectificationAction) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return { ok: false, message: '缺陷不存在' }
    if (isOffline.value) {
      enqueue('整治补录', defect, { recordedAt: action.recordedAt, operator: action.operator, action })
      return { ok: true, message: '离线：整治补录已写入本地队列，恢复后按现场时间合并' }
    }
    defect.actions.unshift(action)
    defect.status = '待复测'
    defect.version += 1
    addAudit(id, '提交整治记录', action.operator, `${action.method}：${action.note}`)
    return { ok: true, message: '整治记录已提交' }
  }

  function addRetest(id: string, retest: RetestResult) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return { ok: false, message: '缺陷不存在' }
    if (isOffline.value) {
      enqueue('复测补录', defect, { recordedAt: retest.testedAt, operator: retest.tester, retest })
      return { ok: true, message: `离线：第${retest.round}轮复测补录已写入本地队列` }
    }
    defect.retests.unshift(retest)
    defect.status = retest.passed ? '已关闭' : '复测不合格'
    defect.version += 1
    addAudit(id, '提交复测', retest.tester, retest.passed ? '复测通过' : `第${retest.round}轮未通过`)
    return { ok: true, message: retest.passed ? '复测通过，缺陷已关闭' : '复测不合格，任务重新进入整治' }
  }

  function transition(id: string, next: DefectStatus) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return { ok: false, message: '缺陷不存在' }
    if (next === '已关闭' && isOffline.value) {
      enqueue('关闭确认', defect, { recordedAt: new Date().toISOString(), operator: '当前用户', note: '现场关闭确认' })
      return { ok: true, message: '离线：关闭确认已写入本地队列，合并时按最新版本重算结论' }
    }
    if (next === '已关闭' && (!defect.retests.length || !defect.retests.some((item) => item.passed))) return { ok: false, message: '没有合格复测记录，不能关闭' }
    if (next === '待复测' && !defect.actions.length) return { ok: false, message: '缺少整治记录，不能申请复测' }
    const prev = defect.status
    defect.status = next
    defect.version += 1
    addAudit(id, `状态流转：${next}`, '当前用户', `由${prev}流转至${next}`)
    return { ok: true, message: `已流转至${next}` }
  }

  function addAudit(entityId: string, action: string, operator: string, detail: string, tag?: AuditTag) {
    audit.value.unshift({ id: `A-${Date.now()}-${idSeed++}`, entityId, action, operator, detail, tag, createdAt: new Date().toISOString() })
  }

  function enqueue(kind: SupplementKind, defect: Defect, payload: { recordedAt: string; operator: string; action?: RectificationAction; retest?: RetestResult; note?: string }) {
    unionQueue(readStoredSupplements())
    const segment = segments.value.find((item) => item.id === defect.segmentId)
    const event: SupplementEvent = {
      id: `S-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind,
      defectId: defect.id,
      operator: payload.operator,
      recordedAt: payload.recordedAt,
      createdAt: new Date().toISOString(),
      baseDefectVersion: defect.version,
      baseSegmentVersion: segment?.version ?? 0,
      status: '待同步',
      action: payload.action,
      retest: payload.retest,
      note: payload.note
    }
    supplements.value.unshift(event)
    addAudit(defect.id, '补录入队', payload.operator, `${kind}已写入本地队列，现场记录时间 ${payload.recordedAt.replace('T', ' ').slice(0, 16)}`)
    persist()
    return event
  }

  function markSupplement(event: SupplementEvent, next: SupplementStatus, reason: string) {
    event.status = next
    event.reason = reason
    event.mergedAt = new Date().toISOString()
  }

  // 网络恢复后合并：按现场记录时间顺序处理，每个补录事件只生效一次
  function mergeSupplements(): MergeSummary {
    const summary: MergeSummary = { merged: 0, pending: 0, conflict: 0, skipped: 0 }
    if (merging || isOffline.value) return summary
    merging = true
    try {
      unionQueue(readStoredSupplements())
      const due = supplements.value
        .filter((item) => item.status === '待同步')
        .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      for (const event of due) {
        const fresh = readStoredSupplements().find((item) => item.id === event.id)
        if (fresh && fresh.status !== '待同步') {
          Object.assign(event, fresh)
          summary.skipped += 1
          continue
        }
        applySupplement(event, summary)
        persist()
      }
      persist()
    } finally {
      merging = false
    }
    return summary
  }

  function applySupplement(event: SupplementEvent, summary: MergeSummary) {
    const defect = defects.value.find((item) => item.id === event.defectId)
    if (!defect) {
      markSupplement(event, '冲突', '缺陷不存在，补录无法合并')
      addAudit(event.defectId, '离线补录·冲突', event.operator, `${event.kind}失败：缺陷不存在`, '冲突')
      summary.conflict += 1
      return
    }
    if (event.kind === '整治补录' && event.action) {
      defect.actions.push(event.action)
      defect.actions.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
      if (defect.status === '整治中' || defect.status === '复测不合格') defect.status = '待复测'
      defect.version += 1
      markSupplement(event, '已合并', '整治记录已并入并照旧保留')
      addAudit(defect.id, '离线补录·已合并', event.operator, `整治补录：${event.action.method}：${event.action.note}`, '已合并')
      summary.merged += 1
      return
    }
    if (event.kind === '复测补录' && event.retest) {
      const existing = defect.retests.find((item) => item.round === event.retest!.round)
      if (existing) {
        markSupplement(event, '待处理', `第${existing.round}轮复测已存在（${existing.tester} ${existing.testedAt.replace('T', ' ').slice(0, 16)}），保留原记录，补录待人工处理`)
        addAudit(defect.id, '离线补录·待处理', event.operator, `第${event.retest.round}轮复测与现有记录同号，保留原记录，不用后到数据覆盖`, '待处理')
        summary.pending += 1
        return
      }
      defect.retests.push(event.retest)
      defect.retests.sort((a, b) => b.round - a.round)
      defect.status = event.retest.passed ? '已关闭' : '复测不合格'
      defect.version += 1
      markSupplement(event, '已合并', `第${event.retest.round}轮复测已并入`)
      addAudit(defect.id, '离线补录·已合并', event.operator, `复测补录第${event.retest.round}轮${event.retest.passed ? '通过' : '未通过'}`, '已合并')
      summary.merged += 1
      return
    }
    // 关闭确认：限速版本或缺陷版本变化后按当前数据重算关闭结论，整治记录照旧保留
    const segment = segments.value.find((item) => item.id === defect.segmentId)
    const segmentVersion = segment?.version ?? 0
    const versionChanged = defect.version !== event.baseDefectVersion || segmentVersion !== event.baseSegmentVersion
    const hasPassedRetest = defect.retests.some((item) => item.passed)
    if (versionChanged) {
      const fromVersion = defect.version
      defect.version += 1
      if (hasPassedRetest) {
        defect.status = '已关闭'
        markSupplement(event, '已合并', `版本变化（缺陷V${event.baseDefectVersion}→V${fromVersion}，区段V${event.baseSegmentVersion}→V${segmentVersion}），关闭结论重算通过`)
        addAudit(defect.id, '离线补录·已合并', event.operator, '关闭确认经版本重算后生效，整治记录照旧保留', '已合并')
        summary.merged += 1
      } else {
        defect.status = '复测不合格'
        markSupplement(event, '冲突', `版本变化（缺陷V${event.baseDefectVersion}→V${fromVersion}，区段V${event.baseSegmentVersion}→V${segmentVersion}）后重算未通过，缺陷回到复测不合格`)
        addAudit(defect.id, '离线补录·冲突', event.operator, '关闭确认重算未通过，状态回到复测不合格', '冲突')
        summary.conflict += 1
      }
      return
    }
    if (hasPassedRetest) {
      defect.status = '已关闭'
      defect.version += 1
      markSupplement(event, '已合并', '关闭确认已合并')
      addAudit(defect.id, '离线补录·已合并', event.operator, '现场关闭确认生效', '已合并')
      summary.merged += 1
    } else {
      markSupplement(event, '冲突', '没有合格复测记录，关闭确认不生效')
      addAudit(defect.id, '离线补录·冲突', event.operator, '关闭确认缺少合格复测，未生效', '冲突')
      summary.conflict += 1
    }
  }

  // 人工处理待处理补录：追加为新轮次，或作废保留原记录
  function resolveSupplement(id: string, decision: 'append' | 'discard') {
    const event = supplements.value.find((item) => item.id === id && item.status === '待处理')
    if (!event) return { ok: false, message: '待处理补录不存在或已处理' }
    const defect = defects.value.find((item) => item.id === event.defectId)
    if (decision === 'append' && defect && event.kind === '复测补录' && event.retest) {
      const round = defect.retests.reduce((max, item) => Math.max(max, item.round), 0) + 1
      defect.retests.push({ ...event.retest, round })
      defect.retests.sort((a, b) => b.round - a.round)
      defect.status = event.retest.passed ? '已关闭' : '复测不合格'
      defect.version += 1
      markSupplement(event, '已合并', `人工处理：作为第${round}轮复测并入`)
      addAudit(defect.id, '离线补录·已合并', event.operator, `待处理复测改记为第${round}轮并入`, '已合并')
      persist()
      return { ok: true, message: `已作为第${round}轮复测并入` }
    }
    markSupplement(event, '冲突', '人工处理：补录作废，保留原记录')
    addAudit(event.defectId, '离线补录·冲突', event.operator, `${event.kind}经人工确认作废，原记录保留`, '冲突')
    persist()
    return { ok: true, message: '补录已作废，原记录保留' }
  }

  function updateSegmentSpeed(id: string, speed: number, temporary: number | undefined) {
    const segment = segments.value.find((item) => item.id === id)
    if (!segment) return { ok: false, message: '区段不存在' }
    const conflict = defects.value.some((item) => item.segmentId === id && item.status !== '已关闭' && item.severity === '一级')
    if (conflict && (!temporary || temporary >= speed)) return { ok: false, message: '一级缺陷未关闭时必须设置更低临时限速' }
    segment.speedLimit = speed
    segment.temporarySpeedLimit = temporary
    segment.version += 1
    addAudit(id, '更新区段速度版本', '工务调度', `正式限速${speed} km/h，临时限速${temporary ?? '无'}`)
    return { ok: true, message: '区段速度版本已更新' }
  }

  function reset() {
    segments.value = structuredClone(seedSegments)
    defects.value = structuredClone(seedDefects)
    audit.value = structuredClone(seedAudit)
    supplements.value = []
    localStorage.removeItem(STORAGE_KEY)
  }

  watch([segments, defects, audit, supplements], persist, { deep: true, flush: 'sync' })

  return { segments, defects, audit, supplements, keyword, status, selectedSegmentId, filtered, selectedSegment, online, forceOffline, offlineSwitch, isOffline, pendingCount, assign, addAction, addRetest, transition, mergeSupplements, resolveSupplement, setOnline, setForceOffline, updateSegmentSpeed, reset }
})
