export type DefectStatus = '待派工' | '整治中' | '待复测' | '复测不合格' | '已关闭'
export type DefectType = '轨距' | '高低' | '方向' | '三角坑'
export type Severity = '一级' | '二级' | '三级'

export interface GeometryMeasurement {
  id: string
  mileage: number
  gauge: number
  level: number
  alignment: number
  twist: number
  measuredAt: string
  detector: string
}

export interface TrackSegment {
  id: string
  line: string
  startMileage: number
  endMileage: number
  speedLimit: number
  temporarySpeedLimit?: number
  version: number
  measurements: GeometryMeasurement[]
}

export interface RectificationAction {
  method: '打磨' | '捣固' | '更换' | '垫板调整' | '测量复核'
  note: string
  operator: string
  recordedAt: string
}

export interface RetestResult {
  round: number
  passed: boolean
  measuredValue: number
  limit: number
  note: string
  tester: string
  testedAt: string
}

/** 关闭结论的依据：以哪一轮复测、哪个缺陷版本、哪个区段限速版本关闭 */
export interface ClosureBasis {
  round: number
  defectVersion: number
  segmentVersion: number
}

export interface Defect {
  id: string
  segmentId: string
  mileage: number
  type: DefectType
  severity: Severity
  measuredValue: number
  limit: number
  status: DefectStatus
  owner: string
  discoveredAt: string
  dueDate: string
  actions: RectificationAction[]
  retests: RetestResult[]
  version: number
  closureBasis?: ClosureBasis
}

/** 离线补录合并结果的审计分类 */
export type AuditCategory = '已合并' | '待处理' | '冲突'

export interface AuditEntry {
  id: string
  entityId: string
  action: string
  operator: string
  detail: string
  createdAt: string
  category?: AuditCategory
}

export type OfflineEventKind = 'rectification' | 'retest' | 'closure'
/** pending=待合并 merged=已合并 held=待处理 conflict=冲突 */
export type OfflineEventStatus = 'pending' | 'merged' | 'held' | 'conflict'

export interface ClosureConfirmation {
  note: string
}

export type OfflinePayload = RectificationAction | RetestResult | ClosureConfirmation

export interface OfflineEvent {
  /** 全局唯一，保证同一补录事件只生效一次 */
  eventId: string
  kind: OfflineEventKind
  defectId: string
  operator: string
  /** 现场记录时间，合并时按此排序 */
  recordedAt: string
  enqueuedAt: string
  /** 入队时看到的缺陷版本 */
  baseDefectVersion: number
  payload: OfflinePayload
  status: OfflineEventStatus
  statusNote?: string
  mergedAt?: string
}
