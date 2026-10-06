import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import { useTrackStore } from '/workspace/src/stores/track'

const KEY = 'gsb66:track-geometry'
const storageMap = new Map()
globalThis.localStorage = {
  getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
  setItem: (k, v) => storageMap.set(k, String(v)),
  removeItem: (k) => storageMap.delete(k)
}
const listeners = {}
globalThis.window = { addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn) } }
function fireStorage() {
  const newValue = storageMap.get(KEY)
  for (const fn of listeners.storage ?? []) fn({ key: KEY, newValue })
}

let failures = 0
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failures += 1
}

// 窗口A：班组，断网前打开页面，随后离线补录
setActivePinia(createPinia())
const crew = useTrackStore()
crew.setForceOffline(true)
crew.addAction('GD-260929-01', { method: '捣固', note: '离线整治', operator: '李海', recordedAt: '2026-10-06T01:00:00' })
crew.addRetest('GD-260929-01', { round: 1, passed: true, measuredValue: 1440, limit: 1446, note: '离线复测', tester: '王磊', testedAt: '2026-10-06T02:00:00' })
crew.transition('GD-260929-01', '已关闭')
crew.transition('GD-260929-02', '已关闭')
const defectA = () => crew.defects.find((d) => d.id === 'GD-260929-01')
const defectB = () => crew.defects.find((d) => d.id === 'GD-260929-02')
check('断网时四件事全部留在本机队列', crew.supplements.length === 4 && crew.supplements.every((s) => s.status === '待同步'))
check('离线期间不直接改当前状态', defectA().status === '整治中' && defectA().retests.length === 0 && defectA().actions.length === 1)

// 窗口B：调度中心，网络正常，期间新增复测记录、整治记录和限速版本
setActivePinia(createPinia())
const dispatch = useTrackStore()
check('重开窗口后队列还在（持久化）', dispatch.supplements.length === 4)
dispatch.addRetest('GD-260929-01', { round: 1, passed: true, measuredValue: 1441, limit: 1446, note: '调度复测', tester: '周旭', testedAt: '2026-10-06T03:00:00' })
dispatch.addAction('GD-260929-02', { method: '打磨', note: '调度期间追加整治', operator: '周旭', recordedAt: '2026-10-06T03:10:00' })
dispatch.updateSegmentSpeed('SEG-K102', 160, 80)
check('调度窗口持久化不冲掉班组队列', (JSON.parse(storageMap.get(KEY)).supplements ?? []).length === 4)

// 班组网络恢复：先同步到调度的改动，再自动合并
fireStorage()
crew.setForceOffline(false)
await nextTick()

const byKind = (id, kind) => crew.supplements.find((s) => s.defectId === id && s.kind === kind)
check('整治补录已合并且整治记录照旧保留', byKind('GD-260929-01', '整治补录').status === '已合并' && defectA().actions.some((a) => a.note === '离线整治'))
check('同编号复测保留原记录，补录列入待处理', byKind('GD-260929-01', '复测补录').status === '待处理' && defectA().retests.length === 1 && defectA().retests[0].tester === '周旭')
check('版本变化后关闭结论重算通过', byKind('GD-260929-01', '关闭确认').status === '已合并' && defectA().status === '已关闭')
check('重算未通过回到复测不合格', byKind('GD-260929-02', '关闭确认').status === '冲突' && defectB().status === '复测不合格')
check('重算不丢整治记录', defectB().actions.length === 2)
check('审计区分已合并/待处理/冲突', ['已合并', '待处理', '冲突'].every((tag) => crew.audit.some((a) => a.tag === tag)))

// 幂等：两个窗口重复合并，每个补录事件只生效一次
const again = crew.mergeSupplements()
fireStorage()
const other = dispatch.mergeSupplements()
check('重复合并不重复生效', again.merged === 0 && other.merged === 0 && defectA().retests.length === 1 && defectA().actions.length === 2)

// 待处理补录人工处理：追加为新轮次
const pendingId = byKind('GD-260929-01', '复测补录').id
const resolved = crew.resolveSupplement(pendingId, 'append')
check('待处理复测追加为新轮次', resolved.ok && defectA().retests.length === 2 && defectA().retests.some((r) => r.round === 2 && r.note === '离线复测'))

// 重开浏览器（新 pinia 实例）队列与合并结果仍在
setActivePinia(createPinia())
const reopened = useTrackStore()
check('重开浏览器后队列与状态保留', reopened.supplements.length === 4 && reopened.supplements.every((s) => s.status !== '待同步') && reopened.defects.find((d) => d.id === 'GD-260929-02').status === '复测不合格')

console.log(failures ? `\n${failures} 项失败` : '\n全部通过')
process.exit(failures ? 1 : 0)
