/**
 * 本机字体的持久化（IndexedDB，纯本地、无网络）：
 * - 数据库 app029-fonts / 表 localFonts，保存「本机登记」的字体记录（含字体二进制）；
 * - 与 localStorage 中的项目/预设/偏好物理隔离：字库到上限只会清理字体数据，
 *   绝不会挤掉项目设置；
 * - 删除/清理 = 留墓碑（保留名称、来源、授权确认人，清掉二进制），
 *   引用它的项目按名称规则统一回落或统一提示；
 * - 浏览器禁用 IndexedDB（如隐私模式）时所有读写安全降级为 null，
 *   由调用方明示「仅当前会话有效」，不装作已保存。
 */

import type { FontEntryStatus } from './fontRegistry'

export interface LocalFontRecord {
  id: string
  label: string
  family: string
  weights: number[]
  license: string
  licenseConfirmedBy: string
  /** 上传时的文件名 */
  source: string
  sizeBytes: number
  createdAt: number
  lastUsedAt: number
  status: FontEntryStatus
  removedAt: number | null
  statusNote: string
  /** 字体二进制；墓碑为 null */
  data: ArrayBuffer | null
}

const DB_NAME = 'app029-fonts'
const DB_VERSION = 1
const STORE = 'localFonts'

export function fontStoreAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined'
  } catch {
    return false
  }
}

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (!fontStoreAvailable()) return Promise.resolve(null)
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION)
        req.onupgradeneeded = () => {
          const db = req.result
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve(null)
        req.onblocked = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  }
  return dbPromise
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDb().then((db) => {
    if (!db) return null
    return new Promise<T | null>((resolve) => {
      try {
        const t = db.transaction(STORE, mode)
        const req = run(t.objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve(null)
        t.onerror = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  })
}

export async function listLocalFontRecords(): Promise<LocalFontRecord[]> {
  const rows = await tx('readonly', (s) => s.getAll() as IDBRequest<LocalFontRecord[]>)
  return rows ?? []
}

/** 写入记录；返回 false 表示存储不可用或写入失败（调用方需明示，不得装作已保存） */
export async function putLocalFontRecord(rec: LocalFontRecord): Promise<boolean> {
  const r = await tx('readwrite', (s) => s.put(rec))
  return r !== null
}

export async function readLocalFontRecord(id: string): Promise<LocalFontRecord | null> {
  return (await tx('readonly', (s) => s.get(id) as IDBRequest<LocalFontRecord | undefined>)) ?? null
}

export async function updateLocalFontRecord(id: string, patch: Partial<LocalFontRecord>): Promise<void> {
  const rec = await readLocalFontRecord(id)
  if (!rec) return
  await putLocalFontRecord({ ...rec, ...patch, id })
}

export async function deleteLocalFontRecord(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id))
}
