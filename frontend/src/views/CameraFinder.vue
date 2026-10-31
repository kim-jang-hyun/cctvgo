<template>
  <div class="finder">
    <header class="finder-head">
      <router-link to="/cameras" class="back">← 카메라 관리</router-link>
      <h2>카메라 추가</h2>
    </header>

    <!-- 1. 카메라 선택 -->
    <section v-if="step === 'select'" class="card">
      <p class="desc">같은 네트워크(공유기)에 연결된 카메라를 찾습니다. 추가할 카메라 옆의 [추가]를 누르세요.</p>
      <button :disabled="scanning" @click="runScan">
        {{ scanning ? '찾는 중... (최대 20초)' : '다시 찾기' }}
      </button>
      <p v-if="scanError" class="error">{{ scanError }}</p>

      <ul v-if="scanned" class="camera-list">
        <li v-for="c in cameras" :key="c.ip" class="list-item">
          <span class="grow">
            <strong>{{ c.ip }}</strong>
            <span v-if="c.vendor || c.model" class="tag">{{ [c.vendor, c.model].filter(Boolean).join(' ') }}</span>
            <span v-if="c.ports.length" class="muted">포트 {{ c.ports.join(', ') }}</span>
          </span>
          <span v-if="registeredHosts.has(c.ip)" class="done">등록됨</span>
          <button v-else class="primary" @click="pickCamera(c)">추가</button>
        </li>
      </ul>
      <p v-if="scanned && cameras.length === 0" class="muted">찾은 카메라가 없습니다.</p>

      <p class="manual-head">목록에 카메라가 없으면 아래 두 방법 중 <strong>하나</strong>로 추가하세요.</p>

      <div class="manual-box">
        <p class="manual-title">방법 1. IP 주소로 추가</p>
        <div class="row">
          <input v-model.trim="ip" placeholder="예: 192.168.0.10" inputmode="decimal" />
          <button :disabled="!ip" @click="goCredentials">다음</button>
        </div>
      </div>

      <p class="or">또는</p>

      <div class="manual-box">
        <p class="manual-title">방법 2. RTSP 주소로 추가</p>
        <p class="muted">카메라나 녹화기(NVR) 설명서에 있는 RTSP 주소를 그대로 붙여 넣으세요.</p>
        <input v-model.trim="rtspUrl" placeholder="rtsp://192.168.0.5:554/Streaming/Channels/201" autocomplete="off" />
        <label>카메라 아이디</label>
        <input v-model.trim="rtspUser" autocomplete="off" />
        <label>카메라 비밀번호</label>
        <input v-model="rtspPassword" type="password" autocomplete="off" />
        <label>카메라 이름</label>
        <input v-model.trim="rtspName" placeholder="예: 거실" maxlength="30" />
        <button class="primary" :disabled="!rtspUrl" @click="runRtspProbe">접속 테스트 후 추가</button>
      </div>
    </section>

    <!-- 2. 아이디/비밀번호 -->
    <section v-else-if="step === 'credentials'" class="card">
      <p class="desc"><strong>{{ ip }}</strong><span v-if="vendorHint" class="tag">{{ vendorHint }}</span></p>
      <label>카메라 아이디</label>
      <input v-model.trim="username" autocomplete="off" />
      <label>카메라 비밀번호</label>
      <input v-model="password" type="password" autocomplete="off" @keyup.enter="runProbe(false)" />
      <p class="notice warn">{{ LOGIN_WARNING }}</p>
      <div class="row">
        <button @click="reset">처음으로</button>
        <button class="primary" :disabled="!username" @click="runProbe(false)">주소 찾기</button>
      </div>
    </section>

    <!-- 3. 탐색 중 -->
    <section v-else-if="step === 'probing'" class="card center">
      <div class="spinner"></div>
      <p>카메라 주소를 찾는 중입니다... (최대 1분)</p>
    </section>

    <!-- 4. 결과: 찾음 -->
    <section v-else-if="step === 'result'" class="card">
      <p class="ok">카메라 주소를 찾았습니다.</p>
      <div v-if="result.candidates.length > 1" class="candidates">
        <label v-for="(c, i) in result.candidates" :key="c.url" class="radio">
          <input type="radio" v-model="selected" :value="i" />
          <span>{{ c.label || '스트림 ' + (i + 1) }}</span>
        </label>
      </div>
      <p class="url">{{ maskedUrl(result.candidates[selected].url) }}</p>

      <label>카메라 이름</label>
      <input v-model.trim="name" placeholder="예: 거실" maxlength="30" />
      <p v-if="saveError" class="error">{{ saveError }}</p>
      <div class="row">
        <button @click="reset">처음으로</button>
        <button class="primary" :disabled="saving" @click="save(result.candidates[selected], name)">{{ saving ? '추가 중...' : '추가' }}</button>
      </div>
    </section>

    <!-- 5. 결과: 못 찾음 -->
    <section v-else-if="step === 'failed'" class="card">
      <p class="error">{{ failMessage }}</p>
      <div class="row wrap">
        <template v-if="origin === 'rtsp'">
          <button @click="step = 'select'">RTSP 주소 다시 입력</button>
        </template>
        <template v-else>
          <button @click="step = 'credentials'">아이디/비밀번호 다시 입력</button>
          <button @click="step = 'manual'">주소 직접 입력</button>
          <button @click="reset">처음으로</button>
        </template>
      </div>
      <div v-if="result && result.diagnostics" class="diag">
        <label>진단 정보 (문의 시 함께 보내 주세요. 비밀번호는 포함되지 않습니다)</label>
        <textarea ref="diagRef" readonly :value="result.diagnostics" rows="8" @focus="$event.target.select()"></textarea>
        <button @click="copyDiagnostics">{{ copied ? '복사됨' : '진단 정보 복사' }}</button>
      </div>
    </section>

    <!-- 6. 직접 입력 + 접속 테스트 -->
    <section v-else-if="step === 'manual'" class="card">
      <p class="desc">카메라 설명서에 있는 RTSP 주소의 포트와 경로를 입력하고 접속을 테스트합니다.</p>
      <p class="muted">예) rtsp://아이디:비밀번호@{{ ip }}:<b>554</b><b>/stream1</b></p>
      <label>포트</label>
      <input v-model.trim="port" placeholder="554" inputmode="numeric" />
      <label>경로</label>
      <input v-model.trim="path" placeholder="/stream1" />
      <p class="notice">접속 테스트에서 로그인이 실패하면 카메라 잠금 방지를 위해 실패 횟수에 합산됩니다.</p>
      <div class="row">
        <button @click="step = 'failed'">뒤로</button>
        <button class="primary" :disabled="!path" @click="runProbe(true)">접속 테스트</button>
      </div>
    </section>

    <!-- 7. 추가 완료 -->
    <section v-else-if="step === 'saved'" class="card center">
      <template v-if="applied">
        <p class="ok">카메라를 추가했습니다.</p>
        <p class="muted">잠시 후 영상 화면에 나타납니다.</p>
      </template>
      <template v-else>
        <p class="ok">카메라를 추가했습니다.</p>
        <p class="notice">추가는 되었지만 {{ APPLY_FAILED }}</p>
      </template>
      <div class="row">
        <router-link to="/cameras" class="btn">카메라 관리로</router-link>
        <router-link to="/" class="btn primary">영상 화면으로</router-link>
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api';
import { messageFor, maskedUrl, APPLY_FAILED, LOGIN_WARNING } from '../finder-messages';

// --- 상태 ---
const step = ref('select');   // select | credentials | probing | result | failed | manual | saved
const origin = ref('scan');   // scan: 찾기/IP 입력으로 들어옴, rtsp: RTSP 주소 직접 입력
const cameras = ref([]);
const scanning = ref(false);
const scanned = ref(false);
const scanError = ref('');
const registeredHosts = ref(new Set());

const ip = ref('');
const port = ref('');
const path = ref('');
const vendorHint = ref('');
const username = ref('admin');
const password = ref('');

const rtspUrl = ref('');
const rtspUser = ref('');
const rtspPassword = ref('');
const rtspName = ref('');

const result = ref(null);
const failMessage = ref('');
const selected = ref(0);
const name = ref('');
const saving = ref(false);
const saveError = ref('');
const applied = ref(true);
const copied = ref(false);
const diagRef = ref(null);

// --- 동작 ---
async function loadRegistered() {
  try {
    registeredHosts.value = new Set((await api('/api/cameras')).cameras.map(c => c.host));
  } catch (e) {
    registeredHosts.value = new Set();
  }
}

async function runScan() {
  scanning.value = true;
  scanError.value = '';
  try {
    const data = await api('/api/finder/scan', { method: 'POST', body: '{}' });
    cameras.value = data.cameras;
    scanned.value = true;
  } catch (e) {
    scanError.value = e.message;
  } finally {
    scanning.value = false;
  }
}

function pickCamera(c) {
  origin.value = 'scan';
  ip.value = c.ip;
  port.value = c.ports.length ? String(c.ports[0]) : '';
  vendorHint.value = [c.vendor, c.model].filter(Boolean).join(' ');
  step.value = 'credentials';
}

function goCredentials() {
  origin.value = 'scan';
  vendorHint.value = '';
  step.value = 'credentials';
}

/** probe 를 실행하고, 못 찾으면 failed 단계로 보낸다. 찾았으면 결과를 돌려준다 */
async function probe(body) {
  step.value = 'probing';
  try {
    result.value = await api('/api/finder/probe', { method: 'POST', body: JSON.stringify(body) });
  } catch (e) {
    failMessage.value = e.message;
    result.value = null;
    step.value = 'failed';
    return null;
  }
  if (result.value.status !== 'found') {
    failMessage.value = messageFor(result.value, vendorHint.value);
    step.value = 'failed';
    return null;
  }
  return result.value;
}

async function runProbe(manual) {
  const body = {
    ip: ip.value,
    username: username.value,
    password: password.value,
    vendorHint: vendorHint.value,
  };
  if (manual) {
    body.path = path.value;
    if (port.value) body.port = port.value;
  }
  if (!(await probe(body))) return;
  selected.value = 0;
  saveError.value = '';
  step.value = 'result';
}

async function runRtspProbe() {
  origin.value = 'rtsp';
  vendorHint.value = '';
  const r = await probe({ rtspUrl: rtspUrl.value, username: rtspUser.value, password: rtspPassword.value });
  if (!r) return;
  saveError.value = '';
  const ok = await save(r.candidates[0], rtspName.value);
  if (!ok) {
    // 접속은 됐지만 저장 실패 (중복 등): 입력 화면으로 돌아가 이유를 보여 준다
    scanError.value = saveError.value;
    step.value = 'select';
  }
}

// 후보에 서브 스트림(H.265 카메라의 PC 브라우저용 대체)이 있으면 함께 저장한다
async function save(candidate, cameraName) {
  saving.value = true;
  saveError.value = '';
  try {
    const r = await api('/api/cameras', { method: 'POST', body: JSON.stringify({ url: candidate.url, name: cameraName, subUrl: candidate.subUrl || null }) });
    applied.value = r.applied;
    step.value = 'saved';
    return true;
  } catch (e) {
    saveError.value = e.message;
    return false;
  } finally {
    saving.value = false;
  }
}

async function copyDiagnostics() {
  const text = result.value?.diagnostics || '';
  try {
    await navigator.clipboard.writeText(text);   // http(LAN) 주소에서는 사용할 수 없을 수 있다
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

function reset() {
  step.value = 'select';
  password.value = '';
  path.value = '';
  port.value = '';
  result.value = null;
  name.value = '';
}

onMounted(() => {
  loadRegistered();
  runScan();
});
</script>

<style scoped>
.notice.warn { color: #b45309; font-weight: 600; }
/* body/#app 이 overflow: hidden 이라 이 화면이 직접 스크롤해야 한다.
   body 배경은 항상 흰색이므로 글자색과 정렬도 #app 기본값 대신 직접 지정한다 */
.finder { height: 100dvh; overflow-y: auto; padding: 16px; box-sizing: border-box; text-align: left; color: #213547; }
.finder > * { max-width: 560px; margin-left: auto; margin-right: auto; }
.finder-head { margin-bottom: 12px; }
.finder-head h2 { margin: 8px 0 0; }
.back { font-size: 14px; color: #007bff; text-decoration: none; }
.card { background: #fff; color: #222; border: 1px solid #ddd; border-radius: 8px; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
.card.center { align-items: center; text-align: center; }
label { font-size: 13px; font-weight: 600; margin-top: 4px; }
/* iOS 는 16px 보다 작은 입력 칸을 누르면 화면을 확대한다 */
input, select, textarea { width: 100%; box-sizing: border-box; padding: 8px 10px; font-size: 16px; border: 1px solid #bbb; border-radius: 6px; }
textarea { font-family: monospace; font-size: 12px; }
button, .btn { padding: 8px 14px; font-size: 14px; border: 1px solid #bbb; background: #f5f5f5; color: #222; border-radius: 6px; cursor: pointer; text-decoration: none; display: inline-block; }
button.primary, .btn.primary { background: #007bff; border-color: #007bff; color: #fff; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.row { display: flex; gap: 8px; align-items: center; }
.row input { flex: 1; }
.row.wrap { flex-wrap: wrap; }
.camera-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.list-item { display: flex; gap: 10px; align-items: center; border: 1px solid #ddd; border-radius: 8px; padding: 8px 10px; }
.grow { flex: 1; display: flex; gap: 6px 10px; align-items: center; flex-wrap: wrap; min-width: 0; }
.done { color: #2e7d32; font-size: 13px; font-weight: 700; white-space: nowrap; }
.tag { background: #e8f1ff; color: #0056b3; border-radius: 4px; padding: 1px 6px; font-size: 12px; }
.muted { color: #777; font-size: 13px; margin: 0; }
.desc { margin: 0 0 4px; }
.notice { background: #fff8e1; border: 1px solid #ffe08a; border-radius: 6px; padding: 8px; font-size: 13px; margin: 4px 0; }
.error { color: #c62828; margin: 4px 0; word-break: keep-all; }
.ok { color: #2e7d32; font-weight: 700; margin: 0; }
.url { font-family: monospace; background: #f3f3f3; padding: 6px 8px; border-radius: 6px; word-break: break-all; }
.radio { display: flex; gap: 8px; align-items: center; font-weight: 400; }
.radio input { width: auto; }
.manual-head { margin: 16px 0 0; border-top: 1px solid #eee; padding-top: 16px; }
/* 두 직접 입력 방법이 한 양식처럼 보이지 않도록 각각 상자로 나눈다 */
.manual-box { background: #fafafa; border: 1px solid #ddd; border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 6px; }
.manual-title { margin: 0; font-weight: 700; }
.or { text-align: center; color: #777; font-size: 13px; margin: 0; }
.diag { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
.spinner { width: 32px; height: 32px; border: 4px solid #ddd; border-top-color: #007bff; border-radius: 50%; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
