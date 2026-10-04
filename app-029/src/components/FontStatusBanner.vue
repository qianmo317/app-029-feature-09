<script setup lang="ts">
/**
 * 项目所用字体的状态条：
 * - 同名自带字顶替（本地上传数据取不到）：黄色警告，说清来源差异，给换字体入口；
 * - 不可用（字库没有该名称/字重、或解析失败）：红色拦截，明确「无法排版」，给一条换成别的字体的路子。
 * 绝不静默：没有可用字体数据时不会装作没事。
 */
import { computed, ref as vueRef, watch } from 'vue'
import { fontState } from '../logic/fontLoader'
import type { Session } from '../logic/useSession'

const props = defineProps<{ session: Session }>()

const resolved = computed(() => {
  // 依赖 fontTick：解析完成/切换字体后重算
  void props.session.fontTick.value
  return props.session.fontRef.value
})
const state = computed(() => {
  void props.session.fontTick.value
  return fontState(resolved.value.familyName || resolved.value.font?.family || '', resolved.value.weight)
})

const kind = computed<'ok' | 'fallback' | 'bad'>(() => {
  if (resolved.value.missing || state.value.state === 'error') return 'bad'
  if (state.value.state === 'fallback') return 'fallback'
  return 'ok'
})

const currentLabel = computed(() => {
  const r = resolved.value
  if (r.font) return `${r.font.label}（${r.font.family}）· 字重 ${r.weight}`
  return r.familyName ? `「${r.familyName}」· 字重 ${r.weight}` : `未知字体 · 字重 ${r.weight}`
})

const switchId = vueRef('')
const switchWeight = vueRef(0)

const fonts = computed(() => props.session.replacementFonts.value)

watch(
  fonts,
  (list) => {
    if (switchId.value && list.some((f) => f.id === switchId.value)) return
    // 默认推荐第一项与当前不同的可用字体
    const other = list.find((f) => f.id !== resolved.value.font?.id) ?? list[0]
    if (other) {
      switchId.value = other.id
      switchWeight.value = other.weights[0]?.weight ?? 400
    }
  },
  { immediate: true }
)

watch(switchId, (id) => {
  const f = fonts.value.find((x) => x.id === id)
  if (f && !f.weights.some((w) => w.weight === switchWeight.value)) {
    switchWeight.value = f.weights[0]?.weight ?? 400
  }
})

const switchFontObj = computed(() => fonts.value.find((f) => f.id === switchId.value) ?? null)
const switchWeights = computed(() => switchFontObj.value?.weights.map((w) => w.weight) ?? [])

function applySwitch(): void {
  if (!switchId.value || !switchWeight.value) return
  props.session.switchFont(switchId.value, switchWeight.value)
}
</script>

<template>
  <div v-if="kind !== 'ok'" :class="['banner', kind === 'bad' ? 'bad' : 'warn']">
    <template v-if="kind === 'bad'">
      <b>该项目字体不可用，当前无法排版：</b>
      <div>该项目使用的是 {{ currentLabel }}。{{ state.message }}</div>
    </template>
    <template v-else>
      <b>字体替代提示：</b>
      <div>{{ state.message }}</div>
    </template>
    <div class="row" style="margin-top: 6px; align-items: center">
      <span class="muted">换成字库中另一份：</span>
      <select v-model="switchId">
        <option v-for="f in fonts" :key="f.id" :value="f.id">
          {{ f.label }}（{{ f.family }}）{{ f.local ? '· 本机登记' : '· 自带' }}
        </option>
      </select>
      <select v-model.number="switchWeight">
        <option v-for="w in switchWeights" :key="w" :value="w">{{ w }}</option>
      </select>
      <button class="primary" @click="applySwitch">换用该字体</button>
    </div>
  </div>
</template>
