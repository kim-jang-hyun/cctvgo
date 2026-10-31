<template>
  <div class="edit">
    <header class="edit-head">
      <router-link to="/cameras" class="back">← 카메라 관리</router-link>
      <h2>카메라 수정</h2>
    </header>

    <section v-if="step === 'loading'" class="card"><p class="muted">불러오는 중...</p></section>

    <section v-else-if="step === 'missing'" class="card">
      <p class="error">{{ failMessage || '목록이 바뀌었습니다. 화면을 다시 열어 주세요.' }}</p>
      <router-link to="/cameras" class="btn">카메라 관리로</router-link>
    </section>

    <!-- 1. 입력 -->
    <section v-else-if="step === 'form'" class="card">
      <p class="desc"><strong>{{ camera.host }}</strong><span v-if="camera.port !== 554" class="muted"> : {{ camera.port }}</span></p>
      <label>카메라 이름</label>
      <input v-model.trim="name" maxlength="30" />
      <label>카메라 아이디</label>
      <input v-model.trim="username" autocomplete="off" />
      <label>카메라 비밀번호</label>
      <input v-model="password" type="password" autocomplete="off" placeholder="바꾸지 않으려면 비워 두세요" @keyup.enter="save" />
      <p class="notice">아이디나 비밀번호를 바꾸면 카메라에 다시 접속해 확인합니다.</p>
      <p class="notice warn">{{ LOGIN_WARNING }}</p>
      <p v-if="saveError" class="error">{{ saveError }}</p>
      <div class="row">
        <router-link to="/cameras" class="btn">취소</router-link>
        <button class="primary" :disabled="!username && !!camera.username" @click="save">저장</button>
      </div>
    </section>

    <!-- 2. 확인 중 -->
    <section v-else-if="step === 'probing'" class="card center">
      <div class="spinner"></div>
      <p>카메라에 접속해 확인하는 중입니다... (최대 1분)</p>
    </section>

    <!-- 3. 스트림 선택 -->
    <section v-else-if="step === 'choose'" class="card">
      <p class="ok">카메라 주소를 찾았습니다. 사용할 영상을 고르세요.</p>
      <label v-for="(c, i) in candidates" :key="i" class="radio">
        <input type="radio" v-model="selected" :value="i" />
        <span>{{ c.label }} <span class="url">{{ c.maskedUrl }}</span></span>
      </label>
      <p v-if="saveError" class="error">{{ saveError }}</p>
      <div class="row">
        <button @click="step = 'form'">뒤로</button>
        <button class="primary" @click="confirmChoice">이 주소로 저장</button>
      </div>
    </section>

    <!-- 4. 실패 -->
    <section v-else-if="step === 'failed'" class="card">
      <p class="error">{{ failMessage }}</p>
      <p class="muted">카메라 설정은 바뀌지 않았습니다.</p>
      <div class="row wrap">
        <button @click="step = 'form'">다시 입력</button>
        <router-link to="/cameras" class="btn">카메라 관리로</router-link>
      </div>
      <div v-if="diagnostics" class="diag">
        <label>진단 정보 (문의 시 함께 보내 주세요. 비밀번호는 포함되지 않습니다)</label>
        <textarea ref="diagRef" readonly :value="diagnostics" rows="8" @focus="$event.target.select()"></textarea>
        <button @click="copyDiagnostics">{{ copied ? '복사됨' : '진단 정보 복사' }}</button>
      </div>
    </section>

    <!-- 5. 저장 완료 -->
    <section v-else-if="step === 'saved'" class="card center">
      <p class="ok">저장했습니다.</p>
      <p v-if="!applied" class="notice">저장은 되었지만 {{ APPLY_FAILED }}</p>
      <router-link to="/cameras" class="btn primary">카메라 관리로</router-link>
    </section>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api';
import { messageFor, APPLY_FAILED, LOGIN_WARNING } from '../finder-messages';

const route = useRoute();
const index = Number(route.params.index);
const hash = String(route.query.hash || '');

const step = ref('loading');   // loading | missing | form | probing | choose | failed | saved
const camera = ref(null);
const name = ref('');
const username = ref('');
const password = ref('');
const candidates = ref([]);
const selected = ref(0);
const failMessage = ref('');
const diagnostics = ref('');
const saveError = ref('');
const applied = ref(true);
const copied = ref(false);
const diagRef = ref(null);

async function load() {
  try {
    const found = (await api('/api/cameras')).cameras.find(c => c.index === index && c.hash === hash);
    if (!found) { step.value = 'missing'; return; }
    camera.value = found;
    name.value = found.name;
    username.value = found.username;
    step.value = 'form';
  } catch (e) {
    failMessage.value = e.message;
    step.value = 'missing';
  }
}

function handleSaved(r) {
  applied.value = r.applied;
  step.value = 'saved';
}

async function save() {
  saveError.value = '';
  // 아이디/비밀번호를 바꾸지 않으면 서버가 카메라에 접속하지 않고 이름만 바꾼다
  const credentialsChanged = username.value !== camera.value.username || password.value !== '';
  if (credentialsChanged) step.value = 'probing';
  let r;
  try {
    r = await api(`/api/cameras/${index}/edit`, {
      method: 'POST',
      body: JSON.stringify({ hash, name: name.value, username: username.value, password: password.value }),
    });
  } catch (e) {
    if (e.status === 409 && /목록이 바뀌었습니다/.test(e.message)) {
      failMessage.value = e.message;
      step.value = 'missing';
      return;
    }
    saveError.value = e.message;
    step.value = 'form';
    return;
  }
  if (r.status === 'saved') return handleSaved(r);
  if (r.status === 'choose') {
    candidates.value = r.candidates;
    selected.value = r.preselect || 0;
    step.value = 'choose';
    return;
  }
  failMessage.value = messageFor(r);
  diagnostics.value = r.diagnostics || '';
  step.value = 'failed';
}

async function confirmChoice() {
  saveError.value = '';
  try {
    handleSaved(await api(`/api/cameras/${index}/edit/confirm`, {
      method: 'POST',
      body: JSON.stringify({ hash, choice: selected.value }),
    }));
  } catch (e) {
    saveError.value = e.message;
  }
}

async function copyDiagnostics() {
  try {
    await navigator.clipboard.writeText(diagnostics.value);   // http(LAN) 주소에서는 사용할 수 없을 수 있다
  } catch (e) {
    if (diagRef.value) {
      diagRef.value.focus();
      diagRef.value.select();
      document.execCommand('copy');
    }
  }
  copied.value = true;
  setTimeout(() => { copied.value = false; }, 2000);
}

onMounted(load);
</script>

<style scoped>
.notice.warn { color: #b45309; font-weight: 600; }
/* body/#app 이 overflow: hidden 이라 이 화면이 직접 스크롤해야 한다 (CameraFinder.vue 와 같은 이유) */
.edit { height: 100dvh; overflow-y: auto; padding: 16px; box-sizing: border-box; text-align: left; color: #213547; }
.edit > * { max-width: 560px; margin-left: auto; margin-right: auto; }
.edit-head { margin-bottom: 12px; }
.edit-head h2 { margin: 8px 0 0; }
.back { font-size: 14px; color: #007bff; text-decoration: none; }
.card { background: #fff; color: #222; border: 1px solid #ddd; border-radius: 8px; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
.card.center { align-items: center; text-align: center; }
label { font-size: 13px; font-weight: 600; margin-top: 4px; }
/* iOS 는 16px 보다 작은 입력 칸을 누르면 화면을 확대한다 */
input, textarea { width: 100%; box-sizing: border-box; padding: 8px 10px; font-size: 16px; border: 1px solid #bbb; border-radius: 6px; }
textarea { font-family: monospace; font-size: 12px; }
button, .btn { padding: 8px 14px; font-size: 14px; border: 1px solid #bbb; background: #f5f5f5; color: #222; border-radius: 6px; cursor: pointer; text-decoration: none; display: inline-block; }
button.primary, .btn.primary { background: #007bff; border-color: #007bff; color: #fff; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.row { display: flex; gap: 8px; align-items: center; }
.row.wrap { flex-wrap: wrap; }
.muted { color: #777; font-size: 13px; margin: 0; }
.desc { margin: 0 0 4px; }
.notice { background: #fff8e1; border: 1px solid #ffe08a; border-radius: 6px; padding: 8px; font-size: 13px; margin: 4px 0; }
.error { color: #c62828; margin: 4px 0; word-break: keep-all; }
.ok { color: #2e7d32; font-weight: 700; margin: 0; }
.url { font-family: monospace; font-size: 12px; color: #555; word-break: break-all; }
.radio { display: flex; gap: 8px; align-items: center; font-weight: 400; }
.radio input { width: auto; }
.diag { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
.spinner { width: 32px; height: 32px; border: 4px solid #ddd; border-top-color: #007bff; border-radius: 50%; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
