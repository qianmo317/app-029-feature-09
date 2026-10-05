<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { parse } from 'opentype.js'
import testchars from '../data/testchars.json'
import {
  FONT_CHARSET_NOTE,
  ensureFont,
  fontState,
  getGlyphGeom,
  listFonts,
  localFontUsage,
  localFontsReady,
  previewEviction,
  purgeLocalFontRecord,
  registerLocalFont,
  removeLocalFont,
  type RuntimeFont
} from '../logic/fontLoader'
import { formatBytes, type FontEntryMeta } from '../logic/fontRegistry'
import { listProjects, loadPrefs, savePrefs } from '../logic/store'

const prefs = ref(loadPrefs())
const tick = ref(0)
const restored = ref(false)
const uploadMsg = ref('')
const uploadMsgKind = ref<'warn' | 'bad' | 'ok'>('warn')
const busy = ref(false)

const fonts = computed(() => listFonts())
const testList = computed(() => (testchars as unknown as { chars: Array<{ char: string }> }).chars.map((c) => c.char))

const usage = computed(() => {
  void tick.value
  return localFontUsage()
})
const usagePct = computed(() => Math.min(100, Math.round((usage.value.usedBytes / usage.value.quotaBytes) * 100)))

/** 可试排/可选用的字体（不含墓碑） */
const activeFonts = computed(() => {
  void tick.value
  return fonts.value.filter((f) => f.status === 'ready')
})
/** 已删除/已清理的登记（墓碑：保留名称、来源、授权确认人） */
const tombstones = computed(() => {
  void tick.value
  return fonts.value.filter((f) => f.status !== 'ready')
})

const projects = computed(() => {
  void tick.value
  return listProjects()
})

function usedByProjects(fontId: string): string[] {
  return projects.value.filter((p) => p.layout.settings.fontId === fontId).map((p) => p.name)
}

const defaultFontGone = computed(() => {
  void tick.value
  if (!restored.value) return false
  const id = prefs.value.defaultFontId
  return !activeFonts.value.some((f) => f.id === id)
})

interface FontCard {
  id: string
  label: string
  family: string
  feature: string
  license: string
  licenseConfirmedBy: string
  source: string
  local: boolean
  sessionOnly: boolean
  sizeText: string
  createdText: string
  usedBy: string[]
  weights: Array<{ weight: number; file: string; state: string; message: string }>
  coverage: number
  missingChars: string[]
  samplePaths: Array<{ char: string; d: string; x0: number; y0: number; ok: boolean }>
}

const cards = computed<FontCard[]>(() => {
  void tick.value
  return activeFonts.value.map((f) => {
    const weights = f.weights.map((w) => {
      const st = fontState(f.id, w.weight)
      return { weight: w.weight, file: w.file, state: st.state, message: st.message }
    })
    let coverage = 0
    const missingChars: string[] = []
    for (const ch of testList.value) {
      const g = getGlyphGeom(f.id, f.weights[0]?.weight ?? 400, ch)
      if (g && !g.missing) coverage++
      else missingChars.push(ch)
    }
    const samplePaths = testList.value.slice(0, 8).map((ch) => {
      const g = getGlyphGeom(f.id, f.weights[0]?.weight ?? 400, ch)
      if (!g || g.missing || !g.pathData) return { char: ch, d: '', x0: 0, y0: 0, ok: false }
      return { char: ch, d: g.pathData, x0: g.bbox.x0, y0: g.bbox.y0, ok: true }
    })
    return {
      id: f.id,
      label: f.label,
      family: f.family,
      feature: f.feature,
      license: f.license,
      licenseConfirmedBy: f.licenseConfirmedBy,
      source: f.source,
      local: !!f.local,
      sessionOnly: !!f.sessionOnly,
      sizeText: f.local ? formatBytes(f.sizeBytes) : '随应用打包',
      createdText: f.local && f.createdAt ? new Date(f.createdAt).toLocaleString('zh-CN') : '—',
      usedBy: usedByProjects(f.id),
      weights,
      coverage,
      missingChars,
      samplePaths
    }
  })
})

onMounted(async () => {
  busy.value = true
  await localFontsReady
  restored.value = true
  tick.value++
  for (const f of listFonts()) {
    if (f.status !== 'ready') continue
    for (const w of f.weights) {
      try {
        await ensureFont(f.id, w.weight)
      } catch {
        // 「该字体不可用」会显示在卡片上
      }
    }
  }
  busy.value = false
  tick.value++
})

// ---------- 上传登记（两步：先解析预检，再确认授权信息登记） ----------

interface PendingFont {
  name: string
  buffer: ArrayBuffer
  family: string
  weight: number
  glyphs: number
}
const pending = ref<PendingFont | null>(null)
const licenseForm = ref({ confirmedBy: '', license: '用户自行确认可商用使用' })
const evictAsk = ref<FontEntryMeta[] | null>(null)
const registering = ref(false)

function say(msg: string, kind: 'warn' | 'bad' | 'ok' = 'warn'): void {
  uploadMsg.value = msg
  uploadMsgKind.value = kind
}

async function onUpload(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  uploadMsg.value = ''
  evictAsk.value = null
  try {
    const buf = await file.arrayBuffer()
    const font = parse(buf)
    if (!font || !font.unitsPerEm) throw new Error('empty')
    pending.value = {
      name: file.name,
      buffer: buf,
      family: font.names?.fontFamily?.en ?? file.name.replace(/\.(ttf|otf)$/i, ''),
      weight: font.tables?.os2?.usWeightClass ?? 400,
      glyphs: font.numGlyphs
    }
  } catch {
    pending.value = null
    say(`「${file.name}」该字体不可用：无法解析字体数据`, 'bad')
  }
}

function cancelPending(): void {
  pending.value = null
  evictAsk.value = null
}

async function confirmRegister(): Promise<void> {
  const p = pending.value
  if (!p || registering.value) return
  if (!licenseForm.value.confirmedBy.trim()) {
    say('请填写「授权确认人」：谁确认这份字体可商用，登记里要写清。', 'bad')
    return
  }
  const plan = previewEviction(p.buffer.byteLength)
  if (!plan) {
    say(
      `本地字库空间不足：即使清理全部本机字体也放不下这份 ${formatBytes(p.buffer.byteLength)} 的字体（上限 ${formatBytes(usage.value.quotaBytes)}），未做任何登记。`,
      'bad'
    )
    return
  }
  if (plan.evict.length && !evictAsk.value) {
    // 先列出要腾谁，用户确认后再登记（不许悄悄清）
    evictAsk.value = plan.evict
    return
  }
  registering.value = true
  try {
    const res = await registerLocalFont(
      p.name,
      p.buffer,
      { license: licenseForm.value.license.trim() || '用户自行确认可商用使用', confirmedBy: licenseForm.value.confirmedBy.trim() },
      (evictAsk.value ?? []).map((e) => e.id)
    )
    const evictNote = res.evicted.length ? `；已为腾空间清理 ${res.evicted.length} 份最久未使用的字体（登记记录保留）` : ''
    say(
      res.sessionOnly
        ? `已登记「${res.font.family}」，但浏览器禁止了本地存储，仅当前会话有效，刷新后需重新上传${evictNote}`
        : `已登记「${res.font.family}」到本机字库：刷新/重开页面后仍在，可给项目选用，也可设为默认字体${evictNote}`,
      'ok'
    )
    pending.value = null
    evictAsk.value = null
    licenseForm.value = { confirmedBy: licenseForm.value.confirmedBy, license: '用户自行确认可商用使用' }
  } catch (err) {
    say(err instanceof Error ? err.message : '该字体不可用', 'bad')
  } finally {
    registering.value = false
    tick.value++
  }
}

async function removeFont(f: RuntimeFont): Promise<void> {
  const usedBy = usedByProjects(f.id)
  const msg = usedBy.length
    ? `以下项目正在使用该字体：${usedBy.join('、')}。\n删除后：有同名自带字体的项目会按名称自动改用自带字体；没有同名的项目会明确提示「字体不可用」并需更换字体。\n\n确认删除「${f.label}」？`
    : `确认删除「${f.label}」？字体数据将从本机清除（保留一条删除记录，便于项目页说明原因）。`
  if (!window.confirm(msg)) return
  await removeLocalFont(f.id)
  tick.value++
}

async function purgeFont(f: RuntimeFont): Promise<void> {
  if (!window.confirm(`彻底清除「${f.label}」的登记记录？（字体数据此前已清除；引用它的项目会按保存的字体名称继续提示）`)) return
  await purgeLocalFontRecord(f.id)
  tick.value++
}

function setDefault(fontId: string, weight: number): void {
  prefs.value = savePrefs({ defaultFontId: fontId, defaultWeight: weight })
}
</script>

<template>
  <div class="page">
    <section class="card">
      <header>
        <h1>本地字库管理</h1>
        <span class="hint">{{ busy ? '正在解析字体…' : `共 ${activeFonts.length} 项可用` }}</span>
      </header>
      <div class="banner info">{{ FONT_CHARSET_NOTE }}</div>
      <p class="muted">
        自带字体随应用打包（public/fonts），断网可用；本机登记的字体持久保存在本机浏览器（IndexedDB），刷新/重开页面后仍在字库中，
        可像自带字体一样给项目选用。解析失败会明确提示「该字体不可用」，不会静默退化。
      </p>
      <p class="muted">
        默认字体：{{ prefs.defaultFontId }} / 字重 {{ prefs.defaultWeight }}
        <span v-if="defaultFontGone" class="bad" style="margin-left: 6px">（该默认字体已不可用，新建项目将改用自带黑体）</span>
      </p>

      <div class="field" style="margin-top: 8px">
        <label>上传本地字体（TTF/OTF，登记到本机字库）</label>
        <div class="ctl">
          <input type="file" accept=".ttf,.otf,font/ttf,font/otf" @change="onUpload" />
        </div>
      </div>

      <div v-if="pending" class="banner info" style="margin-top: 8px">
        <div>
          待登记：<b>{{ pending.family }}</b>（文件 {{ pending.name }}，{{ formatBytes(pending.buffer.byteLength) }}，字重
          {{ pending.weight }}，{{ pending.glyphs }} 个字形）
        </div>
        <div class="row" style="margin-top: 6px; gap: 8px; flex-wrap: wrap">
          <label class="muted">授权确认人（必填）</label>
          <input type="text" v-model="licenseForm.confirmedBy" placeholder="谁确认这份字体可商用" style="width: 200px" />
          <label class="muted">授权说明</label>
          <input type="text" v-model="licenseForm.license" style="width: 240px" />
        </div>
        <div v-if="evictAsk" class="banner warn" style="margin-top: 6px">
          空间不足，需先清理以下「最久未使用」的本机字体（只清字体数据，登记记录保留；绝不影响任何项目与预设）：
          <b>{{ evictAsk.map((e) => e.label).join('、') }}</b>
          。再次点击「确认登记」即执行清理并登记。
        </div>
        <div class="row" style="margin-top: 6px">
          <button class="primary" :disabled="registering" @click="confirmRegister">
            {{ registering ? '正在登记…' : evictAsk ? '确认清理并登记' : '确认登记到本机字库' }}
          </button>
          <button @click="cancelPending">取消</button>
        </div>
      </div>
      <div class="banner" :class="uploadMsgKind" v-if="uploadMsg" style="margin-top: 8px">{{ uploadMsg }}</div>

      <ul class="notes" style="margin-top: 8px">
        <li>授权：{{ activeFonts.map((f) => `${f.label}=${f.license}`).join('；') }}</li>
        <li>字重：黑体/宋体各提供 Regular 与 Bold 两个真实字重；楷体/圆体/艺术体与本机登记字体为单字重（界面会标注）。</li>
        <li>同名规则：本机登记与自带字体同名时按「名称」认定是同一字体——排版用本机登记的数据（字重严格匹配），与登记先后无关；本机字体删除后自动改用自带同名字体。</li>
      </ul>
    </section>

    <section class="card" style="margin-top: 14px">
      <header>
        <h2>本机字库存储</h2>
        <span class="hint">{{ usage.persistAvailable ? '持久化可用' : '浏览器存储不可用（仅当前会话）' }}</span>
      </header>
      <div class="kv-list">
        <span class="muted">保存位置</span>
        <span>浏览器 IndexedDB（库 app029-fonts），仅本机有效；项目、预设、偏好设置存在 localStorage，与字库物理隔离</span>
        <span class="muted">容量上限</span>
        <span class="mono">{{ formatBytes(usage.usedBytes) }} / {{ formatBytes(usage.quotaBytes) }}（单个字体 ≤ {{ formatBytes(usage.maxFileBytes) }}）</span>
        <span class="muted">到上限先腾谁</span>
        <span>按「最久未使用」先腾本机字体，登记前会列出要清理的字体并请你确认；只清字体数据（登记记录保留），绝不挤掉项目与预设</span>
      </div>
      <div style="margin-top: 8px; background: #e8ebf1; border-radius: 4px; height: 8px; overflow: hidden">
        <div :style="{ width: usagePct + '%', background: usagePct > 85 ? '#c62828' : '#2f6fce', height: '100%' }"></div>
      </div>
      <p class="muted" style="margin-top: 4px">已用 {{ usagePct }}%，共 {{ usage.count }} 份本机登记字体。</p>
    </section>

    <div class="grid cols-2" style="margin-top: 14px">
      <section v-for="c in cards" :key="c.id" class="card">
        <header>
          <h2>{{ c.label }} · {{ c.family }}</h2>
          <span class="tag" :class="c.weights.some((w) => w.state === 'error') ? 'bad' : 'ok'">
            {{ c.weights.map((w) => (w.state === 'ready' ? '已解析' : w.state === 'error' ? '不可用' : w.state)).join(' / ') }}
          </span>
        </header>
        <p class="muted">{{ c.feature }}</p>
        <div class="kv-list">
          <span class="muted">字重</span><span class="mono">{{ c.weights.map((w) => w.weight).join(' / ') }}</span>
          <span class="muted">字体文件</span><span class="mono">{{ c.weights.map((w) => w.file).join('、') }}</span>
          <span class="muted">授权 / 来源</span><span>{{ c.license }} · {{ c.source }}</span>
          <span class="muted">授权确认人</span><span>{{ c.licenseConfirmedBy }}</span>
          <template v-if="c.local">
            <span class="muted">登记时间 / 大小</span><span>{{ c.createdText }} · {{ c.sizeText }}</span>
          </template>
          <span class="muted">测试字覆盖</span><span class="mono">{{ c.coverage }} / {{ testList.length }}</span>
          <span class="muted">项目引用</span>
          <span>{{ c.usedBy.length ? c.usedBy.join('、') : '无项目使用' }}</span>
        </div>
        <svg viewBox="-60 -1080 8900 1450" class="sheet-svg" style="height: 120px; margin-top: 8px">
          <g v-for="(s, i) in c.samplePaths" :key="i" :transform="`translate(${i * 1100} 0)`">
            <path v-if="s.ok" :d="s.d" fill="#1d2433" fill-rule="evenodd" />
            <text v-else x="500" y="0" text-anchor="middle" style="font-size: 480px; fill: #c62828">缺</text>
          </g>
        </svg>
        <p class="muted" v-if="c.missingChars.length">字库缺少：{{ c.missingChars.join('') }}（使用时会明确提示，不会静默退化）</p>
        <div class="row" style="margin-top: 6px">
          <button
            v-for="w in c.weights"
            :key="w.weight"
            :class="{ primary: prefs.defaultFontId === c.id && prefs.defaultWeight === w.weight }"
            @click="setDefault(c.id, w.weight)"
          >
            设为默认 {{ w.weight }}
          </button>
          <button v-if="c.local" class="danger" @click="removeFont(fonts.find((f) => f.id === c.id)!)">删除</button>
          <span class="muted" v-if="c.sessionOnly">浏览器存储不可用：仅当前会话有效</span>
        </div>
      </section>
    </div>

    <section class="card" style="margin-top: 14px" v-if="tombstones.length">
      <header>
        <h2>已删除 / 已清理的登记</h2>
        <span class="hint">字体数据已不在本机，登记信息保留以便项目页说明原因</span>
      </header>
      <table>
        <thead>
          <tr><th>字体</th><th>来源</th><th>授权确认人</th><th>状态</th><th>引用项目</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="f in tombstones" :key="f.id">
            <td>{{ f.label }}（{{ f.family }}）</td>
            <td>{{ f.source }}</td>
            <td>{{ f.licenseConfirmedBy || '未填写' }}</td>
            <td>
              <span class="tag bad">{{ f.status === 'evicted' ? '已清理（腾空间）' : '已删除' }}</span>
              <div class="muted">{{ f.statusNote }}</div>
            </td>
            <td>{{ usedByProjects(f.id).join('、') || '无' }}</td>
            <td><button class="danger" @click="purgeFont(f)">清除登记记录</button></td>
          </tr>
        </tbody>
      </table>
      <p class="muted">
        引用这些字体的项目：有同名自带字体的会按名称自动改用自带字体；没有同名的会在各页面统一提示「字体不可用」，并可在「排版编辑」页更换字体。
      </p>
    </section>
  </div>
</template>
