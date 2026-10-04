/**
 * 本地上传字体的持久登记（无后端）：
 * - 数据位置：浏览器同源 IndexedDB（库名 app029-fonts，仓库 localFonts），断网可用；
 *   清理浏览器站点数据会一并删除，本机不同浏览器/配置档之间不共享。
 * - 容量上限：LOCAL_FONT_QUOTA_BYTES（默认 20MB），单文件上限 LOCAL_FONT_FILE_LIMIT_BYTES（10MB）。
 * - 到上限先腾谁：只在「没有任何项目、也不是新建项目默认字体」引用的登记里，
 *   按最久未使用（LRU，lastUsedAt 取该登记各字重最小值）删除，腾出足够空间为止；
 *   任何被引用的登记都不会被自动删除（不许悄悄挤掉别的项目设置）。
 *   若没有可腾的登记仍超上限，抛 FontQuotaError，由界面提示用户手动删除/换字体，绝不静默处理。
 */

const DB_NAME = 'app029-fonts'
const DB_VERSION = 1
const STORE = 'localFonts'

/** 本地上传字体总容量上限：20MB */
export const LOCAL_FONT_QUOTA_BYTES = 20 * 1024 * 1024
/** 单个字体文件上限：10MB */
export const LOCAL_FONT_FILE_LIMIT_BYTES = 10 * 1024 * 1024

export interface LocalFontWeight {
  weight: number
  /** 上传时的文件名 */
  fileName: string
  /** TTF/OTF 原始字节 */
  data: ArrayBuffer
  size: number
  uploadedAt: number
  /** 最近一次被排版/解析使用的时间（LRU 依据，节流写入） */
  lastUsedAt: number
}

export interface LocalFontRecord {
  /** 字体名称（nameID 1/16，规范化后）；同名本地字与自带字按此名称认作同一份 */
  family: string
  /** 界面显示名（默认 = 名称，可由用户在登记时改） */
  label: string
  /** 来源说明，例如文件名/网址/供应商 */
  source: string
  /** 授权由谁确认（上传时必填） */
  licenseConfirmer: string
  /** 授权条款备注（可空） */
  licenseNote: string
  /** 登记时间（首次上传，同名同字重再传保留首次时间） */
  registeredAt: number
  weights: LocalFontWeight[]
}

export interface QuotaInfo {
  usedBytes: number
  quotaBytes: number
  fileLimitBytes: number
  /** 超上限时可被自动腾退的候选（未被任何引用占用，已按 LRU 排序） */
  evictable: Array<{ family: string; size: number; lastUsedAt: number }>
}

export class FontQuotaError extends Error {
  readonly info: QuotaInfo
  constructor(message: string, info: QuotaInfo) {
    super(message)
    this.name = 'FontQuotaError'
    this.info = info
  }
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前浏览器不支持 IndexedDB，无法在本机长期登记字体（请检查隐私模式/浏览器设置）'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'family' })
        os.createIndex('registeredAt', 'registeredAt')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('无法打开本机字体库（IndexedDB）'))
  })
  return dbPromise
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode)
        const req = fn(t.objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error ?? new Error('本机字体库读写失败'))
      })
  )
}

export async function getAllRecords(): Promise<LocalFontRecord[]> {
  return (await tx('readonly', (s) => s.getAll() as IDBRequest<LocalFontRecord[]>)) ?? []
}

export async function getRecord(family: string): Promise<LocalFontRecord | null> {
  return (await tx('readonly', (s) => s.get(family) as IDBRequest<LocalFontRecord | undefined>)) ?? null
}

export async function putRecord(record: LocalFontRecord): Promise<void> {
  await tx('readwrite', (s) => s.put(record) as IDBRequest<IDBValidKey>)
}

export async function deleteRecord(family: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(family) as IDBRequest<undefined>)
}

function recordSize(r: LocalFontRecord): number {
  return r.weights.reduce((sum, w) => sum + w.size, 0)
}

/** 汇总本机字体库占用与容量上限 */
export async function getQuotaInfo(protectedKeys: Set<string> = new Set()): Promise<QuotaInfo> {
  const all = await getAllRecords()
  let usedBytes = 0
  const evictable: QuotaInfo['evictable'] = []
  for (const r of all) {
    const size = recordSize(r)
    usedBytes += size
    if (!protectedKeys.has(normFamily(r.family))) {
      evictable.push({
        family: r.family,
        size,
        lastUsedAt: Math.min(...r.weights.map((w) => w.lastUsedAt))
      })
    }
  }
  evictable.sort((a, b) => a.lastUsedAt - b.lastUsedAt)
  return { usedBytes, quotaBytes: LOCAL_FONT_QUOTA_BYTES, fileLimitBytes: LOCAL_FONT_FILE_LIMIT_BYTES, evictable }
}

/**
 * 登记/更新一份本地字体。
 * 超容量时只自动腾退未被引用（protectedKeys 之外）的最久未用登记；
 * 腾不出来就抛 FontQuotaError，绝不删除被引用登记、绝不假装成功。
 * 两阶段提交：先算出「删哪些才够」，只有全程够才真正删——不够时一个都不删（原子，绝不半删）。
 */
export async function saveRecordWithQuota(record: LocalFontRecord, protectedKeys: Set<string>): Promise<{ evicted: string[] }> {
  const norm = normFamily(record.family)
  const evicted: string[] = []
  const all = await getAllRecords()
  let used = 0
  const removable: Array<{ family: string; size: number; lastUsedAt: number }> = []
  for (const r of all) {
    const size = recordSize(r)
    if (normFamily(r.family) === norm) continue // 更新同名登记，旧体积会被覆盖
    used += size
    if (!protectedKeys.has(normFamily(r.family))) {
      removable.push({ family: r.family, size, lastUsedAt: Math.min(...r.weights.map((w) => w.lastUsedAt)) })
    }
  }
  removable.sort((a, b) => a.lastUsedAt - b.lastUsedAt)
  const incoming = recordSize(record)

  // 第一阶段：算出完整腾退计划；计划走不通就整体拒绝（不动任何现有数据）
  let need = used + incoming - LOCAL_FONT_QUOTA_BYTES
  const plan: typeof removable = []
  if (need > 0) {
    for (const item of removable) {
      plan.push(item)
      need -= item.size
      if (need <= 0) break
    }
  }
  if (need > 0) {
    const info = await getQuotaInfo(protectedKeys)
    throw new FontQuotaError(
      `本机字体库已达容量上限（${formatBytes(LOCAL_FONT_QUOTA_BYTES)}），且没有可腾退的未引用登记；` +
        `请先在字库中删除不再使用的字体，或把引用它的项目换成别的字体后再试。`,
      info
    )
  }
  // 第二阶段：计划可行，才真正删除并写入
  for (const item of plan) {
    await deleteRecord(item.family)
    evicted.push(item.family)
  }
  await putRecord(record)
  return { evicted }
}

/** 更新最近使用时间（LRU 依据）；节流由调用方保证 */
export async function touchWeight(family: string, weight: number, when: number): Promise<void> {
  const rec = await getRecord(family)
  if (!rec) return
  const w = rec.weights.find((x) => x.weight === weight)
  if (!w || w.lastUsedAt >= when) return
  w.lastUsedAt = when
  await putRecord(rec)
}

export function normFamily(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  if (n >= 1024) return `${Math.round(n / 1024)}KB`
  return `${n}B`
}
