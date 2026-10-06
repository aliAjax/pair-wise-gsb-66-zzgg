/* 离线补录队列逻辑验证：断网入队 → 调度期间新增复测 → 恢复合并 → 去重 → 关闭重算 → 重启持久化 */
class StorageShim {
  private map = new Map<string, string>()
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null }
  setItem(k: string, v: string) { this.map.set(k, String(v)) }
  removeItem(k: string) { this.map.delete(k) }
  clear() { this.map.clear() }
}
;(globalThis as any).localStorage = new StorageShim()
;(globalThis as any).sessionStorage = new StorageShim()
;(globalThis as any).navigator = { onLine: true }
;(globalThis as any).window = { addEventListener: () => {} }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let failures = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures += 1; console.error(`  ✗ ${name}`, extra ?? '') }
}

const { createPinia, setActivePinia } = await import('pinia')
setActivePinia(createPinia())
const { useTrackStore } = await import('../src/stores/track')
const { QUEUE_STORAGE_KEY } = await import('../src/utils/offlineQueue')
const store = useTrackStore()
const d1 = () => store.defects.find((d: any) => d.id === 'GD-260929-01')!
const d2 = () => store.defects.find((d: any) => d.id === 'GD-260929-02')!

console.log('A. 断网时补录留在本机，不改当前状态')
store.setOnline(false)
await store.enqueueOffline('rectification', 'GD-260929-01', { method: '捣固', note: '离线整治', operator: '李海', recordedAt: '2026-09-29T08:00:00' }, '李海', '2026-09-29T08:00:00')
await store.enqueueOffline('retest', 'GD-260929-01', { round: 1, passed: true, measuredValue: 1444, limit: 1446, note: '现场合格', tester: '王磊', testedAt: '2026-09-29T09:00:00' }, '王磊', '2026-09-29T09:00:00')
await store.enqueueOffline('closure', 'GD-260929-01', { note: '现场确认关闭' }, '李海', '2026-09-29T09:05:00')
check('缺陷状态未被直接修改', d1().status === '整治中' && d1().actions.length === 1 && d1().retests.length === 0)
check('队列有3条待合并', store.offlineQueue.filter((e: any) => e.status === 'pending').length === 3)
check('队列已写入localStorage', JSON.parse(localStorage.getItem(QUEUE_STORAGE_KEY)!).length === 3)

console.log('B. 调度期间新增的同编号复测不被补录覆盖')
store.addRetest('GD-260929-01', { round: 1, passed: false, measuredValue: 1448, limit: 1446, note: '调度复测不合格', tester: '调度员', testedAt: '2026-09-29T09:30:00' })
store.setOnline(true)
await sleep(150)
check('整治记录已合并', d1().actions.some((a: any) => a.note === '离线整治'))
check('原复测保留（调度记录）', d1().retests.length === 1 && d1().retests[0].tester === '调度员')
check('补录复测列入待处理', store.offlineQueue.some((e: any) => e.kind === 'retest' && e.status === 'held'))
check('关闭确认缺少合格复测判定为冲突', store.offlineQueue.some((e: any) => e.kind === 'closure' && e.status === 'conflict'))
check('审计区分已合并/待处理/冲突', ['已合并', '待处理', '冲突'].every((c) => store.audit.some((a: any) => a.category === c)))

console.log('C. 每个补录事件只生效一次')
const queue = JSON.parse(localStorage.getItem(QUEUE_STORAGE_KEY)!)
const merged = queue.find((e: any) => e.status === 'merged')
merged.status = 'pending' // 模拟另一窗口重复提交同一事件
localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queue))
const versionBefore = d1().version
const actionsBefore = d1().actions.length
await store.mergeOfflineQueue()
check('重复事件被去重且未重复生效', d1().version === versionBefore && d1().actions.length === actionsBefore)
check('去重后标记为已合并', store.offlineQueue.find((e: any) => e.eventId === merged.eventId)!.status === 'merged')

console.log('D. 缺陷版本变化后关闭结论重算')
await store.enqueueOffline('retest', 'GD-260929-02', { round: 2, passed: true, measuredValue: 7.6, limit: 8.0, note: '二轮合格', tester: '王磊', testedAt: '2026-09-29T12:00:00' }, '王磊', '2026-09-29T12:00:00')
await store.mergeOfflineQueue()
check('二轮复测合格后关闭', d2().status === '已关闭' && d2().closureBasis?.round === 2)
await store.enqueueOffline('retest', 'GD-260929-02', { round: 3, passed: false, measuredValue: 8.4, limit: 8.0, note: '三轮又超限', tester: '王磊', testedAt: '2026-09-29T13:00:00' }, '王磊', '2026-09-29T13:00:00')
const actionsKept = d2().actions.length
await store.mergeOfflineQueue()
check('更晚的不合格复测使关闭结论重算为复测不合格', d2().status === '复测不合格' && !d2().closureBasis)
check('整治记录照旧保留', d2().actions.length === actionsKept)
check('重算留痕', store.audit.some((a: any) => a.action === '关闭结论重算' && a.entityId === 'GD-260929-02'))

console.log('E. 区段限速版本变化触发重算')
const r = store.updateSegmentSpeed('SEG-K208', 180, undefined)
const d3 = store.defects.find((d: any) => d.id === 'GD-260928-07')!
check('限速更新成功', r.ok === true && store.segments.find((s: any) => s.id === 'SEG-K208')!.version === 4)
check('合格关闭维持且依据刷新', d3.status === '已关闭' && d3.closureBasis?.segmentVersion === 4)
check('重算留痕（维持关闭）', store.audit.some((a: any) => a.action === '关闭结论重算' && a.entityId === 'GD-260928-07'))

console.log('F. 重开浏览器后队列仍在并自动合并')
store.setOnline(false)
await store.enqueueOffline('rectification', 'GD-260929-02', { method: '打磨', note: '重启前补录', operator: '周旭', recordedAt: '2026-09-29T14:00:00' }, '周旭', '2026-09-29T14:00:00')
check('待合并队列非空', store.pendingQueueCount === 1)
setActivePinia(createPinia()) // 模拟重开浏览器：新store实例从localStorage恢复
const store2 = useTrackStore()
check('重启后队列镜像恢复', store2.offlineQueue.some((e: any) => e.status === 'pending' && e.payload.note === '重启前补录'))
await sleep(150)
const d2b = store2.defects.find((d: any) => d.id === 'GD-260929-02')!
check('联网启动后自动合并', store2.pendingQueueCount === 0 && d2b.actions.some((a: any) => a.note === '重启前补录'))

console.log(failures ? `\n${failures} 项失败` : '\n全部通过')
process.exit(failures ? 1 : 0)
