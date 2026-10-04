<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { canonicalSettings, ensureResolved, findFont, listFonts, resolveProjectFont } from '../logic/fontLoader'
import { computeLayout, mountingLabel, textToItems } from '../logic/layout'
import { buildBom } from '../logic/materials'
import { compareMaterials } from '../logic/materials'
import { bomGroupLabel } from '../logic/quote'
import { createProject, deleteProject, duplicateProject, listProjects, loadPreset, loadPrefs, saveProject, savePrefs } from '../logic/store'
import type { Align, Mounting, Project } from '../logic/types'
import { yuan } from '../logic/materials'

const router = useRouter()
const projects = ref<Project[]>([])
const preset = ref(loadPreset())
const initialPrefs = loadPrefs()
const error = ref('')
const batchTick = ref(0)
const selected = ref<string[]>([])

function initialFont(): { id: string; family: string; weight: number } {
  // 默认字体按名称认；偏好里的默认若已不在字库，回落到黑体并提示
  const byName = initialPrefs.defaultFontFamily ? listFonts().find((f) => f.family === initialPrefs.defaultFontFamily) : null
  const f = byName ?? findFont(initialPrefs.defaultFontId) ?? findFont('hei')
  const w = f?.weights.some((x) => x.weight === initialPrefs.defaultWeight) ? initialPrefs.defaultWeight : f?.weights[0]?.weight ?? 400
  return { id: f?.id ?? 'hei', family: f?.family ?? 'Noto Sans SC', weight: w }
}
const initFont = initialFont()

const draft = ref({
  name: '沿街店面门头',
  wMm: 3000,
  hMm: 800,
  frameMm: 60,
  mounting: 'board' as Mounting,
  text: '广告招牌制作',
  fontId: initFont.id,
  fontFamily: initFont.family,
  weight: initFont.weight,
  baseSizeMm: 300,
  align: 'center' as Align,
  trackRatio: 0.1
})

const fonts = computed(() => listFonts())
const selectedDraftFont = computed(() => findFont(draft.value.fontId))
const weightOptions = computed(() => selectedDraftFont.value?.weights.map((w) => w.weight) ?? [400])
/** 偏好里记录的新建默认字体已不在字库（登记被删等）：本次回落，但明确提示，不悄悄改偏好 */
const defaultFontMissing = computed(
  () =>
    !!initialPrefs.defaultFontFamily &&
    !listFonts().some(
      (f) => f.family === initialPrefs.defaultFontFamily && f.weights.some((w) => w.weight === initialPrefs.defaultWeight)
    )
)
const defaultMissingText = computed(() =>
  defaultFontMissing.value
    ? `新建项目默认字体「${initialPrefs.defaultFontFamily}」字重 ${initialPrefs.defaultWeight} 已不可用（本机登记可能已删除）；本次新建临时回落到「${draft.value.fontFamily}」，可在字库页重新指定默认。`
    : ''
)

function pickDraftFont(fontId: string): void {
  draft.value.fontId = fontId
  const f = findFont(fontId)
  if (!f) return
  draft.value.fontFamily = f.family
  if (!f.weights.some((w) => w.weight === draft.value.weight)) draft.value.weight = f.weights[0]?.weight ?? 400
}

function pickDraftWeight(weight: number): void {
  draft.value.weight = weight
}

function refresh(): void {
  projects.value = listProjects()
}

onMounted(refresh)

watch(
  () => draft.value.fontId,
  (id) => {
    const f = findFont(id)
    if (f) draft.value.fontFamily = f.family
    const ws = f?.weights.map((w) => w.weight) ?? [400]
    if (!ws.includes(draft.value.weight)) draft.value.weight = ws[0]
  }
)

function create(): void {
  error.value = ''
  const text = draft.value.text.replace(/\r/g, '')
  if (!text.trim()) {
    error.value = '请至少输入一个字符'
    return
  }
  if (draft.value.wMm <= draft.value.frameMm * 2 || draft.value.hMm <= draft.value.frameMm * 2) {
    error.value = '门头尺寸必须大于边框的两倍（有效安装区不能为负）'
    return
  }
  const p = createProject(draft.value.name.trim() || '新门头', {
    wMm: draft.value.wMm,
    hMm: draft.value.hMm,
    frameMm: draft.value.frameMm
  })
  p.layout.panel.mounting = draft.value.mounting
  const c = canonicalSettings({ fontId: draft.value.fontId, fontFamily: draft.value.fontFamily, weight: draft.value.weight })
  p.layout.settings.fontId = c.fontId
  p.layout.settings.fontFamily = c.fontFamily
  p.layout.settings.weight = c.weight
  p.layout.settings.baseSizeMm = draft.value.baseSizeMm
  p.layout.settings.align = draft.value.align
  p.layout.settings.trackRatio = draft.value.trackRatio
  p.layout.settings.strokeLimitMm = preset.value.process.strokeLimitMm
  p.layout.items = textToItems(text, [], p.layout.settings, draft.value.baseSizeMm)
  saveProject(p)
  // 同步新建默认偏好（名称为准）
  savePrefs({ defaultFontId: c.fontId, defaultFontFamily: c.fontFamily, defaultWeight: c.weight })
  ensureResolved(resolveProjectFont(p.layout.settings, `项目「${p.name}」`)).catch(() => undefined)
  router.push(`/edit/${p.id}`)
}

/** 项目字体状态：ok=可排；missing=引用名称在字库里找不到；unknown=未加载 */
function projectFontState(p: Project): { label: string; cls: string } {
  const r = resolveProjectFont(p.layout.settings, `项目「${p.name}」`)
  const label = r.font ? r.font.label : r.familyName || '未知字体'
  if (r.missing) return { label: `${label}（字体不可用）`, cls: 'bad' }
  return { label, cls: '' }
}

function open(id: string): void {
  router.push(`/edit/${id}`)
}

function duplicate(id: string): void {
  const p = duplicateProject(id)
  refresh()
  if (p) router.push(`/edit/${p.id}`)
}

function remove(id: string): void {
  deleteProject(id)
  selected.value = selected.value.filter((s) => s !== id)
  refresh()
}

function charCount(p: Project): number {
  return p.layout.items.length
}

// ---------- 导视牌批量：统一排版 + 材料汇总 ----------
watch(selected, async () => {
  for (const p of projects.value) {
    if (!selected.value.includes(p.id)) continue
    try {
      await ensureResolved(resolveProjectFont(p.layout.settings, `项目「${p.name}」`))
    } catch {
      // 字体不可用时该项会显示缺失提示
    }
  }
  batchTick.value++
})

const selectedProjects = computed(() => {
  void batchTick.value
  return projects.value.filter((p) => selected.value.includes(p.id))
})

const batchRows = computed(() => {
  void batchTick.value
  return selectedProjects.value.map((p) => {
    const lay = computeLayout(p.layout)
    const bom = buildBom(p, lay, preset.value)
    return { project: p, layout: lay, bom }
  })
})

const batchTotal = computed(() => {
  const rows = batchRows.value
  return {
    sheets: rows.reduce((s, r) => s + r.bom.nesting.sheetCount, 0),
    modules: rows.reduce((s, r) => s + r.bom.led.modules, 0),
    psus: rows.reduce((s, r) => s + r.bom.led.psuCount, 0),
    cents: rows.reduce((s, r) => s + r.bom.totalCents, 0),
    chars: rows.reduce((s, r) => s + r.project.layout.items.length, 0)
  }
})

function applyUnified(): void {
  const c = canonicalSettings({ fontId: draft.value.fontId, fontFamily: draft.value.fontFamily, weight: draft.value.weight })
  const unify = {
    fontId: c.fontId,
    fontFamily: c.fontFamily,
    weight: c.weight,
    baseSizeMm: draft.value.baseSizeMm,
    align: draft.value.align,
    trackRatio: draft.value.trackRatio
  }
  for (const p of listProjects()) {
    if (!selected.value.includes(p.id)) continue
    p.layout.settings.fontId = unify.fontId
    p.layout.settings.fontFamily = unify.fontFamily
    p.layout.settings.weight = unify.weight
    p.layout.settings.baseSizeMm = unify.baseSizeMm
    p.layout.settings.align = unify.align
    p.layout.settings.trackRatio = unify.trackRatio
    p.layout.items = textToItems(p.layout.items.map((i) => i.char).join(''), p.layout.items, p.layout.settings, unify.baseSizeMm)
    saveProject(p)
    ensureResolved(resolveProjectFont(p.layout.settings, `项目「${p.name}」`)).catch(() => undefined)
  }
  refresh()
  batchTick.value++
}
</script>

<template>
  <div class="page">
    <div class="grid cols-2" style="align-items: start">
      <section class="card">
        <header>
          <h1>新建门头（尺寸 + 文字）</h1>
          <span class="hint">建立后进入排版编辑</span>
        </header>
        <div class="banner bad" v-if="error">{{ error }}</div>
        <div class="banner warn" v-if="defaultFontMissing">{{ defaultMissingText }}</div>
        <div class="field">
          <label>项目名称</label>
          <div class="ctl"><input type="text" v-model="draft.name" style="width: 200px" /></div>
        </div>
        <div class="field">
          <label>总宽 × 总高（mm）</label>
          <div class="ctl">
            <input type="number" v-model.number="draft.wMm" min="200" step="10" />
            <span class="muted">×</span>
            <input type="number" v-model.number="draft.hMm" min="100" step="10" />
          </div>
        </div>
        <div class="field">
          <label>铝塑板边框（mm）</label>
          <div class="ctl"><input type="number" v-model.number="draft.frameMm" min="0" step="10" /></div>
        </div>
        <div class="field">
          <label>安装方式</label>
          <div class="ctl">
            <select v-model="draft.mounting">
              <option value="wall">贴墙安装</option>
              <option value="board">挂板安装</option>
              <option value="freestanding">落地立牌</option>
            </select>
          </div>
        </div>
        <div class="field">
          <label>文字（可多行）</label>
          <div class="ctl" style="flex: 1"></div>
        </div>
        <textarea v-model="draft.text" rows="3" placeholder="每行一组文字，例如：&#10;广告招牌&#10;制作安装"></textarea>
        <div class="field" style="margin-top: 8px">
          <label>字体 / 字重</label>
          <div class="ctl">
            <select :value="draft.fontId" @change="pickDraftFont(($event.target as HTMLSelectElement).value)">
              <option v-for="f in fonts" :key="f.id" :value="f.id">
                {{ f.label }}（{{ f.family }}）{{ f.local ? '· 本机' : '· 自带' }}
              </option>
            </select>
            <select :value="draft.weight" @change="pickDraftWeight(Number(($event.target as HTMLSelectElement).value))">
              <option v-for="w in weightOptions" :key="w" :value="w">{{ w }}</option>
            </select>
          </div>
        </div>
        <div class="field">
          <label>字号（mm）</label>
          <div class="ctl"><input type="number" v-model.number="draft.baseSizeMm" min="10" step="10" /></div>
        </div>
        <div class="field">
          <label>对齐</label>
          <div class="ctl">
            <select v-model="draft.align">
              <option value="left">左对齐</option>
              <option value="center">居中</option>
              <option value="right">右对齐</option>
              <option value="justify">两端对齐</option>
            </select>
          </div>
        </div>
        <div class="field">
          <label>默认字距比例</label>
          <div class="ctl">
            <input type="number" v-model.number="draft.trackRatio" min="0" max="1" step="0.01" />
            <span class="muted">× 字号 = {{ (draft.trackRatio * draft.baseSizeMm).toFixed(1) }}mm</span>
          </div>
        </div>
        <div class="row" style="margin-top: 10px">
          <button class="primary" @click="create">建立并进入排版</button>
        </div>
        <p class="muted" style="margin: 8px 0 0">
          有效安装区 = 门头尺寸 − 2×边框 = {{ Math.max(0, draft.wMm - draft.frameMm * 2) }} ×
          {{ Math.max(0, draft.hMm - draft.frameMm * 2) }}mm；字体全部本地打包，断网可用。
        </p>
      </section>

      <section class="card">
        <header>
          <h2>项目列表（本地存储）</h2>
          <span class="hint">共 {{ projects.length }} 个</span>
        </header>
        <p class="muted" v-if="projects.length === 0">暂无项目，左侧建立第一个门头。</p>
        <table v-else>
          <thead>
            <tr>
              <th style="width: 30px"></th>
              <th>项目</th>
              <th class="num">门头 mm</th>
              <th class="num">字数</th>
              <th>更新</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in projects" :key="p.id">
              <td><input type="checkbox" :value="p.id" v-model="selected" /></td>
              <td>
                <a href="#" @click.prevent="open(p.id)">{{ p.name }}</a>
                <div class="muted">
                  <span :class="{ bad: projectFontState(p).cls === 'bad' }">{{ projectFontState(p).label }}</span>
                  · {{ p.layout.settings.baseSizeMm }}mm ·
                  {{ mountingLabel(p.layout.panel.mounting) }}
                </div>
              </td>
              <td class="num">{{ p.layout.panel.wMm }}×{{ p.layout.panel.hMm }}</td>
              <td class="num">{{ charCount(p) }}</td>
              <td class="muted">{{ new Date(p.updatedAt).toLocaleString('zh-CN') }}</td>
              <td>
                <div class="row">
                  <button @click="open(p.id)">排版</button>
                  <button @click="duplicate(p.id)">复制</button>
                  <button class="danger" @click="remove(p.id)">删除</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>

    <section class="card" style="margin-top: 14px">
      <header>
        <h2>导视牌批量：一组牌子统一排布与材料汇总</h2>
        <span class="hint">勾选上方项目（{{ selected.length }} 个已选）</span>
      </header>
      <div class="row" style="margin-bottom: 10px">
        <button :disabled="selected.length === 0" @click="applyUnified">
          把左侧「字体 / 字重 / 字号 / 对齐 / 字距比例」统一应用到所选项
        </button>
        <span class="muted">统一后会按同一套排版参数重排每个项目的文字</span>
      </div>
      <p class="muted" v-if="batchRows.length === 0">勾选 2 个以上项目可汇总板材、LED 与报价。</p>
      <template v-else>
        <table>
          <thead>
            <tr>
              <th>项目</th>
              <th class="num">字数</th>
              <th class="num">字号 mm</th>
              <th class="num">占宽 mm</th>
              <th class="num">板材</th>
              <th class="num">LED 模组</th>
              <th class="num">电源</th>
              <th class="num">利用率</th>
              <th class="num">合计（元）</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in batchRows" :key="r.project.id">
              <td><a href="#" @click.prevent="open(r.project.id)">{{ r.project.name }}</a></td>
              <td class="num">{{ r.project.layout.items.length }}</td>
              <td class="num">{{ r.layout.sizeMm }}</td>
              <td class="num">{{ r.layout.occupiedW }}</td>
              <td class="num">{{ r.bom.nesting.sheetCount }} 张</td>
              <td class="num">{{ r.bom.led.modules }}</td>
              <td class="num">{{ r.bom.led.psuCount }}</td>
              <td class="num">{{ (r.bom.nesting.utilization * 100).toFixed(1) }}%</td>
              <td class="num">{{ yuan(r.bom.totalCents) }}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td>合计</td>
              <td class="num">{{ batchTotal.chars }}</td>
              <td class="num"></td>
              <td class="num"></td>
              <td class="num">{{ batchTotal.sheets }} 张</td>
              <td class="num">{{ batchTotal.modules }}</td>
              <td class="num">{{ batchTotal.psus }}</td>
              <td class="num"></td>
              <td class="num">{{ yuan(batchTotal.cents) }}</td>
            </tr>
          </tfoot>
        </table>
        <ul class="notes" style="margin-top: 8px">
          <li>
            批量汇总只累加材料条目：{{ bomGroupLabel('acrylic') }}、{{ bomGroupLabel('led_module') }}、{{ bomGroupLabel('psu') }}、{{
              bomGroupLabel('glue')
            }}、{{ bomGroupLabel('labor') }}。
          </li>
          <li v-for="r in batchRows" :key="`c${r.project.id}`">
            {{ r.project.name }}：{{ compareMaterials(r.project, r.layout, preset, r.bom)[0].name }} 方案 ¥{{
              yuan(compareMaterials(r.project, r.layout, preset, r.bom)[0].totalCents)
            }}
          </li>
        </ul>
      </template>
    </section>
  </div>
</template>