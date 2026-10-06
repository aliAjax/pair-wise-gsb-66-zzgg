import type { OfflineEvent, OfflineEventKind, OfflineEventStatus } from '../types'

export const QUEUE_STORAGE_KEY = 'gsb66:offline-queue'
const LOCK_KEY = 'gsb66:offline-queue-lock'
const LOCK_NAME = 'gsb66-offline-queue'

/** 每个浏览器窗口（标签页）一个唯一标识，用于生成全局唯一的补录事件编号 */
export const tabId = (() => {
  const cached = sessionStorage.getItem('gsb66:tab-id')
  if (cached) return cached
  const id = `T-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  sessionStorage.setItem('gsb66:tab-id', id)
  return id
})()

export function readQueue(): OfflineEvent[] {
  try {
    const raw = localStorage.getItem(QUEUE_STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export function writeQueue(events: OfflineEvent[]) {
  localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(events))
}

/**
 * 跨窗口互斥执行：优先使用 Web Locks API，老浏览器退化为 localStorage 令牌锁（尽力而为）。
 * 入队和合并共用同一把锁，保证两个窗口同时提交/合并时每条补录只生效一次。
 */
export async function withQueueLock<T>(task: () => T): Promise<T> {
  const locks = (navigator as Navigator & { locks?: { request: (name: string, task: () => T) => Promise<T> } }).locks
  if (locks?.request) return locks.request(LOCK_NAME, task)
  const release = await acquireTokenLock()
  try {
    return task()
  } finally {
    release()
  }
}

async function acquireTokenLock(): Promise<() => void> {
  const token = `${tabId}:${Date.now()}:${Math.random().toString(36).slice(2)}`
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const holder = readLock()
    if (!holder || holder.expiresAt <= Date.now()) {
      localStorage.setItem(LOCK_KEY, JSON.stringify({ token, expiresAt: Date.now() + 5000 }))
      const current = readLock()
      if (current?.token === token) {
        return () => {
          const latest = readLock()
          if (latest?.token === token) localStorage.removeItem(LOCK_KEY)
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25 + Math.random() * 50))
  }
  return () => {}
}

function readLock(): { token: string; expiresAt: number } | null {
  try {
    const raw = localStorage.getItem(LOCK_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export const offlineKindLabels: Record<OfflineEventKind, string> = {
  rectification: '整治记录',
  retest: '复测',
  closure: '关闭确认'
}

export const offlineStatusLabels: Record<OfflineEventStatus, string> = {
  pending: '待合并',
  merged: '已合并',
  held: '待处理',
  conflict: '冲突'
}

export function offlineStatusColor(status: OfflineEventStatus): string {
  return status === 'merged' ? 'success' : status === 'held' ? 'warning' : status === 'conflict' ? 'error' : 'default'
}
