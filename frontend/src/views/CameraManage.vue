<template>
  <div class="manage">
    <header class="manage-head">
      <router-link to="/settings" class="back">← 설정으로</router-link>
      <h2>카메라 관리</h2>
    </header>

    <section class="card">
      <p v-if="loading" class="muted">불러오는 중...</p>
      <p v-else-if="loadError" class="error">{{ loadError }}</p>
      <p v-else-if="cameras.length === 0" class="muted">등록된 카메라가 없습니다.</p>

      <ul v-if="cameras.length" class="camera-list">
        <li v-for="c in cameras" :key="c.hash" class="row-item">
          <span class="grow">
            <strong>{{ displayName(c) }}</strong>
            <span class="muted">{{ displayHost(c) }}</span>
          </span>
          <router-link :to="{ path: `/cameras/${c.index}/edit`, query: { hash: c.hash } }" class="btn">수정</router-link>
          <button class="danger" :disabled="busy" @click="remove(c)">삭제</button>
        </li>
      </ul>

      <p v-if="message" :class="messageError ? 'error' : 'notice'">{{ message }}</p>
      <router-link to="/cameras/add" class="btn primary wide">+ 카메라 추가</router-link>
    </section>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api';
import { APPLY_FAILED } from '../finder-messages';

const cameras = ref([]);
const loading = ref(true);
const loadError = ref('');
const busy = ref(false);
const message = ref('');
const messageError = ref(false);

const displayName = c => c.name || `카메라 ${c.index + 1}`;
const displayHost = c => (c.port && c.port !== 554 ? `${c.host}:${c.port}` : c.host);

async function load() {
  loadError.value = '';
  try {
    cameras.value = (await api('/api/cameras')).cameras;
  } catch (e) {
    loadError.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function remove(c) {
  if (!confirm(`"${displayName(c)}" 카메라를 삭제할까요?`)) return;
  busy.value = true;
  message.value = '';
  try {
    const r = await api(`/api/cameras/${c.index}`, { method: 'DELETE', body: JSON.stringify({ hash: c.hash }) });
    messageError.value = !r.applied;
    message.value = r.applied ? `"${displayName(c)}" 카메라를 삭제했습니다.` : `삭제는 되었지만 ${APPLY_FAILED}`;
  } catch (e) {
    messageError.value = true;
    message.value = e.message;
  } finally {
    busy.value = false;
    await load();
  }
}

onMounted(load);
</script>

<style scoped>
/* body/#app 이 overflow: hidden 이라 이 화면이 직접 스크롤해야 한다 (CameraFinder.vue 와 같은 이유) */
.manage { height: 100dvh; overflow-y: auto; padding: 16px; box-sizing: border-box; text-align: left; color: #213547; }
.manage > * { max-width: 560px; margin-left: auto; margin-right: auto; }
.manage-head { margin-bottom: 12px; }
.manage-head h2 { margin: 8px 0 0; }
.back { font-size: 14px; color: #007bff; text-decoration: none; }
.card { background: #fff; color: #222; border: 1px solid #ddd; border-radius: 8px; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
.camera-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.row-item { display: flex; align-items: center; gap: 8px; border: 1px solid #ddd; border-radius: 8px; padding: 8px 10px; }
.grow { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.grow strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button, .btn { padding: 8px 14px; font-size: 14px; border: 1px solid #bbb; background: #f5f5f5; color: #222; border-radius: 6px; cursor: pointer; text-decoration: none; display: inline-block; text-align: center; }
.primary { background: #007bff; border-color: #007bff; color: #fff; }
.danger { background: #fff; border-color: #e5a0a0; color: #c62828; }
.wide { display: block; margin-top: 8px; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.muted { color: #777; font-size: 13px; }
.notice { background: #fff8e1; border: 1px solid #ffe08a; border-radius: 6px; padding: 8px; font-size: 13px; margin: 4px 0; }
.error { color: #c62828; margin: 4px 0; word-break: keep-all; }
</style>
