<template>
  <div class="finder">
    <header class="finder-head">
      <router-link to="/" class="back">← 영상 화면으로</router-link>
      <h2>카메라 주소 찾기</h2>
    </header>

    <!-- 1. 카메라 선택 -->
    <section v-if="step === 'select'" class="card">
      <p class="desc">같은 네트워크(공유기)에 연결된 카메라를 찾습니다. 카메라의 아이디/비밀번호는 직접 입력해야 합니다.</p>
      <button class="primary" :disabled="scanning" @click="runScan">
        {{ scanning ? '찾는 중... (최대 20초)' : '내 네트워크에서 카메라 찾기' }}
      </button>
      <p v-if="scanError" class="error">{{ scanError }}</p>

      <ul v-if="scanned" class="camera-list">
        <li v-for="c in cameras" :key="c.ip">
          <button class="list-item" @click="pickCamera(c)">
            <strong>{{ c.ip }}</strong>
            <span v-if="c.vendor || c.model" class="tag">{{ [c.vendor, c.model].filter(Boolean).join(' ') }}</span>
            <span v-if="c.ports.length" class="muted">포트 {{ c.ports.join(', ') }}</span>
          </button>
        </li>
      </ul>
      <p v-if="scanned && cameras.length === 0" class="muted">찾은 카메라가 없습니다. 아래에 IP 주소를 직접 입력하세요.</p>

      <div class="manual-ip">
        <label>IP 주소 직접 입력</label>
        <div class="row">
          <input v-model.trim="ip" placeholder="예: 192.168.0.10" inputmode="decimal" />
          <button :disabled="!ip" @click="goCredentials">다음</button>
        </div>
      </div>
    </section>

    <!-- 2. 아이디/비밀번호 -->
    <section v-else-if="step === 'credentials'" class="card">
      <p class="desc"><strong>{{ ip }}</strong><span v-if="vendorHint" class="tag">{{ vendorHint }}</span></p>
      <label>카메라 아이디</label>
      <input v-model.trim="username" autocomplete="off" />
      <label>카메라 비밀번호</label>
      <input v-model="password" type="password" autocomplete="off" @keyup.enter="runProbe(false)" />
      <p class="notice">카메라 잠금 방지를 위해 로그인 실패는 카메라당 최대 2회까지만 시도합니다. 카메라 자체 웹페이지에서 로그인되는 아이디/비밀번호인지 먼저 확인하세요.</p>
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

      <label>저장 방식</label>
      <select v-model="saveMode">
        <option value="append">새 카메라로 추가</option>
        <option v-for="c in existing" :key="c.index" :value="'replace:' + c.index">기존 "{{ c.name || c.host }}" 카메라 교체</option>
      </select>
      <p v-if="saveError" class="error">{{ saveError }}</p>
      <div class="row">
        <button @click="reset">처음으로</button>
        <button class="primary" :disabled="saving" @click="save">{{ saving ? '저장 중...' : 'cctv.txt에 저장' }}</button>
      </div>
    </section>

    <!-- 5. 결과: 못 찾음 -->
    <section v-else-if="step === 'failed'" class="card">
      <p class="error">{{ failMessage }}</p>
      <div class="row wrap">
        <button @click="step = 'credentials'">아이디/비밀번호 다시 입력</button>
        <button @click="step = 'manual'">주소 직접 입력</button>
        <button @click="reset">처음으로</button>
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

    <!-- 7. 저장 완료 -->
    <section v-else-if="step === 'saved'" class="card center">
      <p class="ok">cctv.txt에 저장했습니다.</p>
      <p class="notice">변경 내용을 적용하려면 <strong>cctvgo.bat 창을 닫고 다시 실행</strong>하세요.</p>
      <div class="row">
        <button @click="reset">카메라 더 찾기</button>
        <router-link to="/" class="btn">영상 화면으로</router-link>
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';

const router = useRouter();

// --- 상태 ---
const step = ref('select');   // select | credentials | probing | result | failed | manual | saved
const cameras = ref([]);
const scanning = ref(false);
const scanned = ref(false);
const scanError = ref('');

const ip = ref('');
const port = ref('');
const path = ref('');
const vendorHint = ref('');
const username = ref('admin');
const password = ref('');

const result = ref(null);
const failMessage = ref('');
const selected = ref(0);
const name = ref('');
const existing = ref([]);
const saveMode = ref('append');
const saving = ref(false);
const saveError = ref('');
const copied = ref(false);
const diagRef = ref(null);

// --- API ---
async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const type = res.headers.get('content-type') || '';
  if (res.redirected || !type.includes('application/json')) {
    router.push('/login');   // 세션 만료: authMiddleware 가 /login 으로 리다이렉트한 경우
    throw new Error('로그인이 필요합니다.');
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `요청에 실패했습니다. (${res.status})`);
  return data;
}

// --- 동작 ---
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
  ip.value = c.ip;
  port.value = c.ports.length ? String(c.ports[0]) : '';
  vendorHint.value = [c.vendor, c.model].filter(Boolean).join(' ');
  step.value = 'credentials';
}

function goCredentials() {
  vendorHint.value = '';
  step.value = 'credentials';
}

async function runProbe(manual) {
  step.value = 'probing';
  try {
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
    result.value = await api('/api/finder/probe', { method: 'POST', body: JSON.stringify(body) });
  } catch (e) {
    if (step.value === 'probing') {
      failMessage.value = e.message;
      result.value = null;
      step.value = 'failed';
    }
    return;
  }

  if (result.value.status === 'found') {
    selected.value = 0;
    saveMode.value = 'append';
    saveError.value = '';
    try {
      existing.value = (await api('/api/finder/cameras')).cameras;
    } catch (e) {
      existing.value = [];
    }
    step.value = 'result';
  } else {
    failMessage.value = messageFor(result.value);
    step.value = 'failed';
  }
}

function messageFor(r) {
  const vendor = vendorHint.value ? ` (감지된 제조사: ${vendorHint.value})` : '';
  switch (r.status) {
    case 'unreachable':
      return '카메라에 연결할 수 없습니다. IP 주소가 맞는지, 카메라 전원과 네트워크 연결을 확인하세요.';
    case 'auth_failed':
      return r.ambiguous
        ? `아이디/비밀번호 또는 경로 문제일 수 있습니다.${vendor} 카메라 자체 웹페이지에서 로그인되는 아이디/비밀번호인지 먼저 확인하고, 안 되면 "주소 직접 입력"을 사용하세요.`
        : '카메라 아이디 또는 비밀번호가 맞지 않습니다. 카메라 자체 웹페이지에서 로그인되는 아이디/비밀번호인지 먼저 확인하세요.';
    case 'auth_locked': {
      const min = Math.max(1, Math.ceil((r.retryAfterSec || 0) / 60));
      return `카메라 잠금 방지를 위해 약 ${min}분 뒤에 다시 시도하세요. 그 사이 카메라 자체 웹페이지에서 아이디/비밀번호를 확인해 보세요.`;
    }
    case 'path_not_found':
      return `카메라는 응답했지만 영상 주소를 찾지 못했습니다.${vendor} 카메라 설명서의 RTSP 주소를 확인해 "주소 직접 입력"을 사용하세요.`;
    default:
      return '주소를 찾지 못했습니다.';
  }
}

// 화면에는 비밀번호를 가린 주소를 보여 준다
function maskedUrl(url) {
  return url.replace(/^(rtsp:\/\/[^:@/]*):[^@]*@/, '$1:****@');
}

async function save() {
  saving.value = true;
  saveError.value = '';
  try {
    const body = { url: result.value.candidates[selected.value].url, name: name.value };
    if (saveMode.value.startsWith('replace:')) {
      body.mode = 'replace';
      body.replaceIndex = Number(saveMode.value.split(':')[1]);
    } else {
      body.mode = 'append';
    }
    await api('/api/finder/save', { method: 'POST', body: JSON.stringify(body) });
    step.value = 'saved';
  } catch (e) {
    saveError.value = e.message;
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
</script>

<style scoped>
.finder { max-width: 560px; margin: 0 auto; padding: 16px; box-sizing: border-box; }
.finder-head { margin-bottom: 12px; }
.finder-head h2 { margin: 8px 0 0; }
.back { font-size: 14px; color: #007bff; text-decoration: none; }
.card { background: #fff; color: #222; border: 1px solid #ddd; border-radius: 8px; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
.card.center { align-items: center; text-align: center; }
label { font-size: 13px; font-weight: 600; margin-top: 4px; }
input, select, textarea { width: 100%; box-sizing: border-box; padding: 8px 10px; font-size: 15px; border: 1px solid #bbb; border-radius: 6px; }
textarea { font-family: monospace; font-size: 12px; }
button, .btn { padding: 8px 14px; font-size: 14px; border: 1px solid #bbb; background: #f5f5f5; color: #222; border-radius: 6px; cursor: pointer; text-decoration: none; display: inline-block; }
button.primary { background: #007bff; border-color: #007bff; color: #fff; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.row { display: flex; gap: 8px; align-items: center; }
.row input { flex: 1; }
.row.wrap { flex-wrap: wrap; }
.camera-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.list-item { width: 100%; text-align: left; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.tag { background: #e8f1ff; color: #0056b3; border-radius: 4px; padding: 1px 6px; font-size: 12px; margin-left: 6px; }
.muted { color: #777; font-size: 13px; }
.desc { margin: 0 0 4px; }
.notice { background: #fff8e1; border: 1px solid #ffe08a; border-radius: 6px; padding: 8px; font-size: 13px; margin: 4px 0; }
.error { color: #c62828; margin: 4px 0; word-break: keep-all; }
.ok { color: #2e7d32; font-weight: 700; margin: 0; }
.url { font-family: monospace; background: #f3f3f3; padding: 6px 8px; border-radius: 6px; word-break: break-all; }
.radio { display: flex; gap: 8px; align-items: center; font-weight: 400; }
.radio input { width: auto; }
.manual-ip { margin-top: 12px; border-top: 1px solid #eee; padding-top: 12px; }
.diag { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
.spinner { width: 32px; height: 32px; border: 4px solid #ddd; border-top-color: #007bff; border-radius: 50%; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
