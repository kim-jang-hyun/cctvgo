<template>
  <!-- 실패 안내: 첫 줄은 무엇이 문제인지, "1. ..." 로 시작하는 줄은 확인 순서 목록으로 보여 준다 -->
  <div class="fail" role="alert">
    <p class="title">{{ title }}</p>
    <ol v-if="steps.length" class="steps">
      <li v-for="(s, i) in steps" :key="i">{{ s }}</li>
    </ol>
    <p v-for="(l, i) in rest" :key="'r' + i" class="rest">{{ l }}</p>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({ text: { type: String, default: '' } });
const STEP_RE = /^\d+\.\s*/;
const lines = computed(() => props.text.split('\n').map(l => l.trim()).filter(Boolean));
const title = computed(() => lines.value[0] || '');
const steps = computed(() => lines.value.slice(1).filter(l => STEP_RE.test(l)).map(l => l.replace(STEP_RE, '')));
const rest = computed(() => lines.value.slice(1).filter(l => !STEP_RE.test(l)));
</script>

<style scoped>
.fail { margin: 4px 0; text-align: left; }
.title { margin: 0 0 6px; color: #c62828; font-weight: 600; word-break: keep-all; }
.steps { margin: 0; padding-left: 20px; color: #333; font-size: 14px; line-height: 1.6; word-break: keep-all; }
.steps li + li { margin-top: 2px; }
.rest { margin: 6px 0 0; color: #333; font-size: 14px; word-break: keep-all; }
</style>
