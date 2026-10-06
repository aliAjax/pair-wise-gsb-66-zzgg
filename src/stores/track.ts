import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { seedAudit, seedDefects, seedSegments } from '../data/seed'
import { QUEUE_STORAGE_KEY, offlineKindLabels, readQueue, tabId, withQueueLock, writeQueue } from '../utils/offlineQueue'
import type { AuditCategory, AuditEntry, ClosureConfirmation, Defect, DefectStatus, OfflineEvent, OfflineEventKind, OfflinePayload, RectificationAction, RetestResult, TrackSegment } from '../types'

const STORAGE_KEY = 'gsb66:track-geometry'
let idSeed = 10
let eventSeed = 1

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : { segments: seedSegments, defects: seedDefects, audit: seedAudit, appliedEventIds: [] }
  } catch {
    return { segments: seedSegments, defects: seedDefects, audit: seedAudit, appliedEventIds: [] }
  }
}

export const useTrackStore = defineStore('track', () => {
  const initial = load()
  const segments = ref<TrackSegment[]>(initial.segments)
  const defects = ref<Defect[]>(initial.defects)
  const audit = ref<AuditEntry[]>(initial.audit)
  /** 已生效的补录事件编号，保证每个补录事件只生效一次 */
  const appliedEventIds = ref<string[]>(initial.appliedEventIds ?? [])
  /** 离线补录队列的内存镜像，真实数据始终在 localStorage，重开浏览器后仍在 */
  const offlineQueue = ref<OfflineEvent[]>(readQueue())
  const online = ref(typeof navigator === 'undefined' ? true : navigator.onLine)
  const merging = ref(false)
  const keyword = ref('')
  const status = ref<DefectStatus | '全部'>('全部')
  const selectedSegmentId = ref(segments.value[0]?.id ?? '')

  const filtered = computed(() => defects.value.filter((item) => {
    const segment = segments.value.find((value) => value.id === item.segmentId)
    const text = `${item.id} ${segment?.line ?? ''} ${item.type} ${item.owner}`.toLowerCase()
    return (!keyword.value || text.includes(keyword.value.toLowerCase())) && (status.value === '全部' || item.status === status.value)
  }))

  const selectedSegment = computed(() => segments.value.find((item) => item.id === selectedSegmentId.value))
  const pendingQueueCount = computed(() => offlineQueue.value.filter((item) => item.status === 'pending').length)

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
    if (!defect) return
    defect.actions.unshift(action)
    defect.status = '待复测'
    defect.closureBasis = undefined
    defect.version += 1
    addAudit(id, '提交整治记录', action.operator, `${action.method}：${action.note}`)
  }

  function addRetest(id: string, retest: RetestResult) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return
    defect.retests.unshift(retest)
    defect.status = retest.passed ? '已关闭' : '复测不合格'
    defect.version += 1
    if (retest.passed) markClosureBasis(defect, retest.round)
    else defect.closureBasis = undefined
    addAudit(id, '提交复测', retest.tester, retest.passed ? '复测通过' : `第${retest.round}轮未通过`)
  }

  function transition(id: string, next: DefectStatus) {
    const defect = defects.value.find((item) => item.id === id)
    if (!defect) return { ok: false, message: '缺陷不存在' }
    if (next === '已关闭' && (!defect.retests.length || !defect.retests.some((item) => item.passed))) return { ok: false, message: '没有合格复测记录，不能关闭' }
    if (next === '待复测' && !defect.actions.length) return { ok: false, message: '缺少整治记录，不能申请复测' }
    const prev = defect.status
    defect.status = next
    defect.version += 1
    if (next === '已关闭') {
      const passing = latestPassingRetest(defect)
      if (passing) markClosureBasis(defect, passing.round)
    }
    addAudit(id, `状态流转：${next}`, '当前用户', `由${prev}流转至${next}`)
    return { ok: true, message: `已流转至${next}` }
  }

  function addAudit(entityId: string, action: string, operator: string, detail: string, category?: AuditCategory) {
    audit.value.unshift({ id: `A-${tabId}-${Date.now()}-${idSeed++}`, entityId, action, operator, detail, category, createdAt: new Date().toISOString() })
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
    // 区段限速版本变化后，区段内已关闭缺陷的关闭结论重算
    for (const defect of defects.value) {
      if (defect.segmentId === id) recheckClosure(defect.id)
    }
    return { ok: true, message: '区段速度版本已更新' }
  }

  // —— 离线补录队列 ——

  function setOnline(value: boolean) {
    online.value = value
    if (value) void mergeOfflineQueue()
  }

  function refreshQueue() {
    offlineQueue.value = readQueue()
  }

  /** 预计的下一复测轮次：已合并轮次 + 队列中待合并的复测条数 */
  function nextRetestRound(defectId: string) {
    const defect = defects.value.find((item) => item.id === defectId)
    const maxExisting = defect?.retests.reduce((max, item) => Math.max(max, item.round), 0) ?? 0
    const queued = offlineQueue.value.filter((item) => item.defectId === defectId && item.kind === 'retest' && item.status === 'pending').length
    return maxExisting + queued + 1
  }

  /** 断网时把整治、复测、关闭确认留在本机队列 */
  async function enqueueOffline(kind: OfflineEventKind, defectId: string, payload: OfflinePayload, operator: string, recordedAt: string) {
    const defect = defects.value.find((item) => item.id === defectId)
    const event: OfflineEvent = {
      eventId: `EV-${tabId}-${Date.now().toString(36)}-${eventSeed++}`,
      kind,
      defectId,
      operator,
      recordedAt,
      enqueuedAt: new Date().toISOString(),
      baseDefectVersion: defect?.version ?? 0,
      payload,
      status: 'pending'
    }
    // 入队与合并共用同一把跨窗口锁，两个窗口同时提交不会丢事件
    await withQueueLock(() => {
      const queue = readQueue()
      queue.push(event)
      writeQueue(queue)
    })
    refreshQueue()
    addAudit(defectId, '离线补录入队', operator, `${offlineKindLabels[kind]}已保存在本机（现场时间${recordedAt.replace('T', ' ').slice(0, 16)}），待网络恢复后合并`)
    return event
  }

  /** 网络恢复后合并：按现场记录时间顺序处理，每个事件只生效一次 */
  async function mergeOfflineQueue() {
    const summary = { merged: 0, held: 0, conflict: 0 }
    if (merging.value) return summary
    merging.value = true
    try {
      await withQueueLock(() => {
        const queue = readQueue()
        const pending = queue
          .filter((item) => item.status === 'pending')
          .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.enqueuedAt.localeCompare(b.enqueuedAt) || a.eventId.localeCompare(b.eventId))
        const touched = new Set<string>()
        for (const event of pending) {
          if (appliedEventIds.value.includes(event.eventId)) {
            // 另一窗口已合并过同一事件，去重不重复生效
            event.status = 'merged'
            event.statusNote = '该补录已生效，重复提交被去重'
            event.mergedAt = new Date().toISOString()
            summary.merged += 1
            continue
          }
          applyOfflineEvent(event, touched)
          if (event.status === 'merged') {
            appliedEventIds.value.push(event.eventId)
            summary.merged += 1
          } else if (event.status === 'held') summary.held += 1
          else if (event.status === 'conflict') summary.conflict += 1
        }
        writeQueue(queue)
        // 合并导致缺陷版本变化，受影响的已关闭缺陷重算关闭结论
        for (const defectId of touched) recheckClosure(defectId)
      })
    } finally {
      merging.value = false
      refreshQueue()
    }
    return summary
  }

  function applyOfflineEvent(event: OfflineEvent, touched: Set<string>) {
    const defect = defects.value.find((item) => item.id === event.defectId)
    const fieldTime = event.recordedAt.replace('T', ' ').slice(0, 16)
    if (!defect) {
      event.status = 'conflict'
      event.statusNote = '缺陷不存在，无法合并'
      addAudit(event.defectId, '离线补录冲突', event.operator, `缺陷不存在，现场时间${fieldTime}的补录无法合并`, '冲突')
      return
    }
    if (event.kind === 'rectification') {
      const action = event.payload as RectificationAction
      defect.actions.push(action)
      defect.actions.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
      defect.version += 1
      if (defect.status !== '已关闭') defect.status = '待复测'
      event.status = 'merged'
      event.mergedAt = new Date().toISOString()
      addAudit(defect.id, '合并离线整治记录', action.operator, `${action.method}：${action.note}（现场时间${fieldTime}）`, '已合并')
      touched.add(defect.id)
      return
    }
    if (event.kind === 'retest') {
      const retest = event.payload as RetestResult
      const existing = defect.retests.find((item) => item.round === retest.round)
      if (existing) {
        // 同一编号复测已存在：保留原记录，补录列入待处理，不允许后到数据覆盖
        event.status = 'held'
        event.statusNote = `第${retest.round}轮复测已存在（${existing.tester}，${existing.testedAt.replace('T', ' ').slice(0, 16)}），保留原记录`
        addAudit(defect.id, '离线复测待处理', retest.tester, `第${retest.round}轮复测编号重复，保留原记录，补录待人工核对（现场时间${fieldTime}）`, '待处理')
        return
      }
      defect.retests.push(retest)
      defect.retests.sort((a, b) => b.round - a.round)
      defect.version += 1
      if (defect.status !== '已关闭') {
        defect.status = retest.passed ? '已关闭' : '复测不合格'
        if (retest.passed) markClosureBasis(defect, retest.round)
      }
      event.status = 'merged'
      event.mergedAt = new Date().toISOString()
      addAudit(defect.id, '合并离线复测', retest.tester, `第${retest.round}轮${retest.passed ? '通过' : '未通过'}，${retest.measuredValue} / ${retest.limit}（现场时间${fieldTime}）`, '已合并')
      touched.add(defect.id)
      return
    }
    const confirmation = event.payload as ClosureConfirmation
    if (defect.status === '已关闭') {
      // 关闭确认幂等：缺陷已关闭时不重复生效
      event.status = 'merged'
      event.statusNote = '缺陷已关闭，关闭确认不重复生效'
      event.mergedAt = new Date().toISOString()
      addAudit(defect.id, '合并离线关闭确认', event.operator, '缺陷已处于关闭状态，确认不重复生效', '已合并')
      return
    }
    const passing = latestPassingRetest(defect)
    if (!passing) {
      event.status = 'conflict'
      event.statusNote = '没有合格复测记录，关闭确认与当前状态冲突'
      addAudit(defect.id, '离线补录冲突', event.operator, `关闭确认缺少合格复测（现场时间${fieldTime}）`, '冲突')
      return
    }
    defect.status = '已关闭'
    defect.version += 1
    markClosureBasis(defect, passing.round)
    event.status = 'merged'
    event.mergedAt = new Date().toISOString()
    addAudit(defect.id, '合并离线关闭确认', event.operator, `${confirmation.note || '现场确认关闭'}（现场时间${fieldTime}）`, '已合并')
    touched.add(defect.id)
  }

  function markClosureBasis(defect: Defect, round: number) {
    const segment = segments.value.find((item) => item.id === defect.segmentId)
    defect.closureBasis = { round, defectVersion: defect.version, segmentVersion: segment?.version ?? 0 }
  }

  function latestPassingRetest(defect: Defect) {
    return defect.retests.filter((item) => item.passed).sort((a, b) => b.round - a.round)[0]
  }

  /**
   * 区段限速版本或缺陷版本变化后重算关闭结论：
   * 以最新一轮复测和当前限值复核，没通过就回到复测不合格，整治记录照旧保留。
   */
  function recheckClosure(defectId: string) {
    const defect = defects.value.find((item) => item.id === defectId)
    if (!defect || defect.status !== '已关闭') return
    const segment = segments.value.find((item) => item.id === defect.segmentId)
    const segmentVersion = segment?.version ?? 0
    const basis = defect.closureBasis
    if (basis && basis.defectVersion === defect.version && basis.segmentVersion === segmentVersion) return
    const latest = defect.retests.reduce<RetestResult | undefined>((acc, item) => (!acc || item.round > acc.round ? item : acc), undefined)
    if (latest && latest.passed && latest.measuredValue <= defect.limit) {
      defect.closureBasis = { round: latest.round, defectVersion: defect.version, segmentVersion }
      addAudit(defect.id, '关闭结论重算', '系统', `版本变化后复核第${latest.round}轮复测仍合格（${latest.measuredValue} / ${defect.limit}），维持关闭`)
    } else {
      defect.status = '复测不合格'
      defect.version += 1
      defect.closureBasis = undefined
      const reason = latest ? `第${latest.round}轮复测${latest.passed ? '超过当前限值' : '未通过'}` : '缺少复测记录'
      addAudit(defect.id, '关闭结论重算', '系统', `版本变化后${reason}，关闭结论撤销，回到复测不合格，整治记录保留`)
    }
  }

  function reset() {
    segments.value = structuredClone(seedSegments)
    defects.value = structuredClone(seedDefects)
    audit.value = structuredClone(seedAudit)
    appliedEventIds.value = []
    writeQueue([])
    refreshQueue()
  }

  watch([segments, defects, audit, appliedEventIds], () => localStorage.setItem(STORAGE_KEY, JSON.stringify({ segments: segments.value, defects: defects.value, audit: audit.value, appliedEventIds: appliedEventIds.value })), { deep: true })

  if (typeof window !== 'undefined') {
    // 其他窗口入队或合并后同步本窗口，避免旧数据回写覆盖
    window.addEventListener('storage', (event) => {
      if (event.key === QUEUE_STORAGE_KEY) refreshQueue()
      if (event.key === STORAGE_KEY && event.newValue) {
        const current = JSON.stringify({ segments: segments.value, defects: defects.value, audit: audit.value, appliedEventIds: appliedEventIds.value })
        if (current === event.newValue) return
        try {
          const parsed = JSON.parse(event.newValue)
          segments.value = parsed.segments
          defects.value = parsed.defects
          audit.value = parsed.audit
          appliedEventIds.value = parsed.appliedEventIds ?? []
        } catch {
          // 忽略损坏的同步数据
        }
      }
    })
    window.addEventListener('online', () => setOnline(true))
    window.addEventListener('offline', () => { online.value = false })
    // 重开浏览器后队列仍在：启动时已联网则直接合并
    if (online.value && offlineQueue.value.some((item) => item.status === 'pending')) void mergeOfflineQueue()
  }

  return { segments, defects, audit, keyword, status, selectedSegmentId, filtered, selectedSegment, online, offlineQueue, pendingQueueCount, merging, assign, addAction, addRetest, transition, updateSegmentSpeed, setOnline, enqueueOffline, mergeOfflineQueue, nextRetestRound, reset }
})
