<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import testchars from '../data/testchars.json'
import {
  FONT_CHARSET_NOTE,
  ensureResolved,
  fontState,
  fontStoreError,
  getGlyphGeom,
  initFonts,
  listFonts,
  registerLocalFont,
  removeLocalFont,
  resolveProjectFont,
  type RuntimeFont
} from '../logic/fontLoader'
import { formatBytes, getQuotaInfo, type QuotaInfo } from '../logic/localFontStore'
import { loadPrefs, savePrefs } from '../logic/store'

const prefs = ref(loadPrefs())
const tick = ref(0)
const uploadMsg = ref('')
const uploadOk = ref(false)
const busy = ref(false)
const storeError = ref('')
const quota = ref<QuotaInfo | null>(null)

// 上传登记表单：名称取自字体文件（只读展示），来源与授权确认人必填
const fileInputName = ref('')
const pendingBuffer = ref<ArrayBuffer | null>(null)
const source = ref('')
const confirmer = ref('')
const licenseNote = ref('')
const deleteMsg = ref('')

const fonts = computed<RuntimeFont[]>(() => {
  void tick.value
  return listFonts()
})
const testList = computed(() => (testchars as unknown as { chars: Array<{ char: string }> }).chars.map((c) => c.char))

interface WeightView {
  weight: number
  file: string
  origin: string
  size: string
  state: string
  stateText: string
  message: string
}

interface FontCard {
  f: RuntimeFont
  weights: WeightView[]
  overallCls: string
  overallText: string
  coverage: number
  missingChars: string[]
  samplePaths: Array<{ char: string; d: string; ok: boolean }>
  localSize: string
  isDefault: boolean
}

const cards = computed<FontCard[]>(() => {
  void tick.value
  return fonts.value.map((f) => {
    const firstWeight = f.weights[0]?.weight ?? 400
    const weights: WeightView[] = f.weights.map((w) => {
      const st = fontState(f.family, w.weight)
      const tag = stateTag(st.state)
      return {
        weight: w.weight,
        file: w.fileName,
        origin: w.origin === 'local' ? `本机登记${w.builtInFile ? '（同名自带可顶替）' : ''}` : '自带打包',
        size: w.origin === 'local' && w.localSize ? formatBytes(w.localSize) : `${w.fileSizeKb ?? '—'}KB`,
        state: st.state,
        stateText: tag.text,
        message: st.message
      }
    })
    let coverage = 0
    const missingChars: string[] = []
    for (const ch of testList.value) {
      const g = getGlyphGeom(f.id, firstWeight, ch, f.family)
      if (g && !g.missing) coverage++
      else missingChars.push(ch)
    }
    const samplePaths = testList.value.slice(0, 8).map((ch) => {
      const g = getGlyphGeom(f.id, firstWeight, ch, f.family)
      if (!g || g.missing || !g.pathData) return { char: ch, d: '', ok: false }
      return { char: ch, d: g.pathData, ok: true }
    })
    const localSize = f.weights.filter((w) => w.origin === 'local').reduce((s, w) => s + (w.localSize ?? 0), 0)
    const hasError = weights.some((w) => w.state === 'error')
    const allReady = weights.every((w) => w.state === 'ready' || w.state === 'fallback')
    const overall = stateTag(hasError ? 'error' : allReady ? 'ready' : 'idle')
    return {
      f,
      weights,
      overallCls: overall.cls,
      overallText: weights.map((w) => w.stateText).join(' / '),
      coverage,
      missingChars,
      samplePaths,
      localSize: localSize ? formatBytes(localSize) : '',
      isDefault: prefs.value.defaultFontId === f.id
    }
  })
})

async function refreshQuota(): Promise<void> {
  try {
    quota.value = await getQuotaInfo()
    storeError.value = fontStoreError()
  } catch (e) {
    storeError.value = e instanceof Error ? e.message : '本机字体库不可用'
  }
}

onMounted(async () => {
  busy.value = true
  await initFonts()
  await refreshQuota()
  for (const f of listFonts()) {
    for (const w of f.weights) {
      try {
        await ensureResolved(
          resolveProjectFont({ fontId: f.id, fontFamily: f.family, weight: w.weight }, '字库页')
        )
      } catch {
        // 「该字体不可用」会显示在卡片上
      }
    }
  }
  busy.value = false
  tick.value++
})

async function onPickFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  uploadMsg.value = ''
  if (!file) return
  try {
    pendingBuffer.value = await file.arrayBuffer()
    fileInputName.value = file.name
    if (!source.value) source.value = `本机文件：${file.name}`
  } catch {
    uploadMsg.value = '读取字体文件失败'
    uploadOk.value = false
  } finally {
    input.value = ''
  }
}

async function onUpload(): Promise<void> {
  uploadMsg.value = ''
  if (!pendingBuffer.value) {
    uploadMsg.value = '请先选择 TTF/OTF 字体文件'
    uploadOk.value = false
    return
  }
  if (!source.value.trim() || !confirmer.value.trim()) {
    uploadMsg.value = '登记必须写清「来源」和「授权由谁确认」，否则不予长期保存'
    uploadOk.value = false
    return
  }
  busy.value = true
  try {
    const r = await registerLocalFont(fileInputName.value, pendingBuffer.value, {
      source: source.value.trim(),
      licenseConfirmer: confirmer.value.trim(),
      licenseNote: licenseNote.value.trim()
    })
    const evictText = r.evicted.length
      ? `容量到上限，已按规则腾退最久未用且无项目引用的字体：${r.evicted.join('、')}。`
      : ''
    uploadMsg.value =
      `已在本机长期登记「${r.font.family}」（${r.replaced ? '覆盖同名同字重旧登记' : '新登记'}），刷新或重开页面仍在字库中、可被项目选用。` +
      evictText
    uploadOk.value = true
    pendingBuffer.value = null
    fileInputName.value = ''
    source.value = ''
    confirmer.value = ''
    licenseNote.value = ''
    await refreshQuota()
  } catch (err) {
    uploadMsg.value = err instanceof Error ? err.message : '该字体不可用'
    uploadOk.value = false
  } finally {
    busy.value = false
    tick.value++
  }
}

function setDefault(f: RuntimeFont, weight: number): void {
  prefs.value = savePrefs({ defaultFontId: f.id, defaultFontFamily: f.family, defaultWeight: weight })
}

async function onDelete(f: RuntimeFont): Promise<void> {
  deleteMsg.value = ''
  if (!f.local) return
  if (
    !window.confirm(
      `确定删除本机登记「${f.family}」？\n删除后引用它的项目按同一个名称处理：有同名自带字体则明确标注以自带字顶替，没有则提示字体不可用并可换字体。`
    )
  )
    return
  busy.value = true
  try {
    const r = await removeLocalFont(f.family)
    if (r.referenced) {
      deleteMsg.value =
        `已删除本机登记「${f.family}」。以下引用按同一名称处理：` +
        r.references.map((x) => `${x.from}（字重 ${x.weight}）`).join('、') +
        '——有同名自带字体的会明确标注以自带字体顶替，其余项目请在编辑页换成别的字体。'
    } else {
      deleteMsg.value = `已删除本机登记「${f.family}」；当前没有项目或新建默认引用它。`
    }
    if (prefs.value.defaultFontFamily && f.family === prefs.value.defaultFontFamily) {
      // 不悄悄改默认设置：仅提示用户默认字体引用已失效，由用户重新设定
      deleteMsg.value += ' 注意：它曾是新建项目默认字体，请在下方重新指定默认。'
    }
    await refreshQuota()
  } catch (e) {
    deleteMsg.value = e instanceof Error ? e.message : '删除失败'
  } finally {
    busy.value = false
    tick.value++
  }
}

function stateTag(s: string): { cls: string; text: string } {
  if (s === 'ready') return { cls: 'ok', text: '可排（已解析）' }
  if (s === 'fallback') return { cls: 'warn', text: '同名自带字顶替' }
  if (s === 'error') return { cls: 'bad', text: '不可用' }
  if (s === 'loading') return { cls: 'warn', text: '解析中' }
  return { cls: 'warn', text: s || '未解析' }
}
</script>

<template>
  <div class="page">
    <section class="card">
      <header>
        <h1>本地字库管理</h1>
        <span class="hint">{{ busy ? '正在解析字体…' : `共 ${fonts.length} 项（自带 ${cards.filter((c) => !c.f.local).length} / 本机登记 ${cards.filter((c) => c.f.local).length}）` }}</span>
      </header>
      <div class="banner info">{{ FONT_CHARSET_NOTE }}</div>
      <p class="muted">
        自带字体随应用打包（public/fonts），断网可用；上传的字体登记在<b>本机浏览器 IndexedDB（app029-fonts）</b>，
        刷新或重开页面仍在，可像自带字体一样被项目选用、设为新建项目默认。清理浏览器站点数据会一并删掉本机登记。
      </p>

      <div class="banner bad" v-if="storeError">
        本机字体库存储不可用：{{ storeError }}。自带字体仍可使用，但上传的字体无法长期登记。
      </div>

      <div class="kv-list" v-if="quota" style="margin-top: 8px">
        <span class="muted">本机字体数据位置</span><span>浏览器 IndexedDB / 库 app029-fonts / 仓库 localFonts（仅本机本浏览器，不联网）</span>
        <span class="muted">占用 / 上限</span>
        <span class="mono" :class="{ bad: quota.usedBytes > quota.quotaBytes * 0.9 }">
          {{ formatBytes(quota.usedBytes) }} / {{ formatBytes(quota.quotaBytes) }}（单文件上限 {{ formatBytes(quota.fileLimitBytes) }}）
        </span>
        <span class="muted">到上限先腾谁</span>
        <span>
          只自动删除<b>没有任何项目引用、也不是新建默认字体</b>的登记，按最久未使用（LRU）顺序腾退；
          被引用的登记绝不自动删除（不会悄悄挤掉任何项目的字体设置）；腾不出空间时新登记会被拒绝并明确报错。
        </span>
        <span class="muted">当前可被腾退</span>
        <span class="mono">
          {{ quota.evictable.length ? quota.evictable.map((e) => `${e.family}(${formatBytes(e.size)})`).join('、') : '无（全部都有引用或库为空）' }}
        </span>
      </div>

      <div class="card" style="margin-top: 10px; background: rgba(0,0,0,0.02)">
        <header><h2>上传字体并长期登记到本机</h2></header>
        <div class="field">
          <label>字体文件（TTF/OTF）</label>
          <div class="ctl">
            <input type="file" accept=".ttf,.otf,font/ttf,font/otf" @change="onPickFile" />
            <span class="muted" v-if="fileInputName">已选：{{ fileInputName }}</span>
          </div>
        </div>
        <div class="field">
          <label>来源（必填：文件名/供应商/下载地址）</label>
          <div class="ctl"><input type="text" v-model="source" style="width: 360px" placeholder="例如：供应商 XXX 提供 / https://… / 本机文件：xxx.ttf" /></div>
        </div>
        <div class="field">
          <label>授权由谁确认（必填：责任人/确认方式）</label>
          <div class="ctl">
            <input type="text" v-model="confirmer" style="width: 240px" placeholder="例如：张三已核对商用授权（2026-09）" />
          </div>
        </div>
        <div class="field">
          <label>授权条款备注（可选）</label>
          <div class="ctl"><input type="text" v-model="licenseNote" style="width: 360px" placeholder="例如：SIL OFL 1.1 / 已购企业授权" /></div>
        </div>
        <p class="muted">
          字体名称与字重从文件本身读取，不可手改：自带字体与上传字体<b>同名时按名称认作同一份（不按上传/加载先后）</b>；
          同名同字重再传会覆盖原数据。被删除以后，项目里引用它的地方仍按同一个名称处理。
        </p>
        <div class="row">
          <button class="primary" :disabled="busy || !pendingBuffer" @click="onUpload">登记到本机字库</button>
        </div>
        <div class="banner" :class="uploadOk ? 'info' : 'bad'" v-if="uploadMsg" style="margin-top: 8px">{{ uploadMsg }}</div>
      </div>
    </section>

    <div class="banner warn" v-if="deleteMsg" style="margin-top: 14px">{{ deleteMsg }}</div>

    <div class="grid cols-2" style="margin-top: 14px">
      <section v-for="c in cards" :key="c.f.id" class="card">
        <header>
          <h2>{{ c.f.label }} · {{ c.f.family }}</h2>
          <span class="tag" :class="c.overallCls">{{ c.overallText }}</span>
        </header>
        <p class="muted">{{ c.f.feature }}</p>
        <div class="kv-list">
          <span class="muted">类型</span>
          <span>
            <span class="tag ok" v-if="c.f.builtIn && !c.f.local">自带打包</span>
            <span class="tag warn" v-else-if="c.f.builtIn && c.f.local">自带 + 本机登记（同名，按名称认）</span>
            <span class="tag warn" v-else>本机登记</span>
          </span>
          <span class="muted">字重 / 来源 / 大小</span>
          <span class="mono" v-for="w in c.weights" :key="w.weight">
            {{ w.weight }} · {{ w.origin }} · {{ w.file }} · {{ w.size }}
            <div class="muted" v-if="w.state !== 'ready'">{{ w.message }}</div>
          </span>
          <span class="muted">来源说明</span><span>{{ c.f.source }}</span>
          <span class="muted">授权由谁确认</span><span>{{ c.f.local ? c.f.licenseConfirmer || '—' : '随包发布（' + c.f.license + '）' }}</span>
          <span class="muted">授权条款 / 登记时间</span>
          <span>{{ c.f.local ? (c.f.licenseNote || '见来源方授权条款') : c.f.license }}<template v-if="c.f.registeredAt"> · {{ new Date(c.f.registeredAt).toLocaleDateString('zh-CN') }} 登记</template></span>
          <span class="muted">本机占用</span><span class="mono">{{ c.localSize || '—' }}</span>
          <span class="muted">测试字覆盖</span><span class="mono">{{ c.coverage }} / {{ testList.length }}</span>
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
            v-for="w in c.f.weights"
            :key="w.weight"
            :class="{ primary: prefs.defaultFontId === c.f.id && prefs.defaultWeight === w.weight }"
            @click="setDefault(c.f, w.weight)"
          >
            设为新建默认 {{ w.weight }}
          </button>
          <button class="danger" v-if="c.f.local" @click="onDelete(c.f)">删除本机登记</button>
        </div>
      </section>
    </div>
  </div>
</template>
