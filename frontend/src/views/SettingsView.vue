<template>
  <div class="settings">
    <header class="settings-head">
      <router-link to="/" class="back">← 영상 화면으로</router-link>
      <h2>설정</h2>
    </header>

    <!-- 기능마다 별도 화면으로 들어가는 메뉴 -->
    <nav class="menu">
      <router-link to="/cameras" class="menu-item">
        <span class="menu-text">
          <strong>카메라 관리</strong>
          <span class="menu-desc">카메라를 추가하거나 수정·삭제합니다</span>
        </span>
        <span class="chevron" aria-hidden="true">›</span>
      </router-link>
      <router-link to="/settings/password" class="menu-item">
        <span class="menu-text">
          <strong>비밀번호 변경</strong>
          <span class="menu-desc">이 화면에 로그인할 때 쓰는 비밀번호를 바꿉니다</span>
        </span>
        <span class="chevron" aria-hidden="true">›</span>
      </router-link>
    </nav>

    <!-- 외부에서 영상이 안 보일 때 문의용. 카메라 주소와 비밀번호는 포함되지 않는다 -->
    <section class="diag">
      <div class="diag-head">
        <strong>진단 정보</strong>
        <div class="diag-actions">
          <button type="button" :disabled="downloading" @click="downloadBundle">{{ downloading ? '만드는 중...' : '진단 파일 받기' }}</button>
          <button type="button" :disabled="loading" @click="copyDiagnostics">{{ copied ? '복사됨' : loading ? '불러오는 중...' : '진단 정보 복사' }}</button>
        </div>
      </div>
      <p class="diag-desc">문제가 생기면 [진단 파일 받기]로 받은 zip 파일을 문의할 때 보내 주세요. 기록과 PC 정보가 들어 있고, 카메라와 로그인 비밀번호는 들어 있지 않습니다. (만드는 데 10~20초 걸립니다)</p>
      <p v-if="error" class="diag-error">{{ error }}</p>
      <textarea v-if="text" ref="textRef" readonly :value="text" rows="8" @focus="$event.target.select()"></textarea>
    </section>
  </div>
</template>

<script setup>
import { ref, nextTick } from 'vue';
import { api } from '../api';

const text = ref('');
const loading = ref(false);
const copied = ref(false);
const error = ref('');
const textRef = ref(null);

const downloading = ref(false);

// 진단 파일(zip) 받기. 만드는 데 시간이 걸려 버튼에 진행 상태를 보여 주고, 받은 파일을 바로 저장한다
async function downloadBundle() {
  downloading.value = true;
  error.value = '';
  try {
    const res = await fetch('/api/diagnostics/bundle');
    if (res.redirected) throw new Error('로그인이 필요합니다. 다시 로그인한 뒤 시도하세요.');
    if (!res.ok || !(res.headers.get('content-type') || '').includes('application/zip')) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || `진단 파일을 받지 못했습니다. (${res.status})`);
    }
    const name = (/filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '') || [])[1] || 'cctvgo-diagnostics.zip';
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    error.value = e.message;
  } finally {
    downloading.value = false;
  }
}

async function copyDiagnostics() {
  loading.value = true;
  error.value = '';
  try {
    text.value = (await api('/api/diagnostics')).text;
  } catch (e) {
    error.value = e.message;
    return;
  } finally {
    loading.value = false;
  }
  try {
    await navigator.clipboard.writeText(text.value);   // http(LAN) 주소에서는 사용할 수 없을 수 있다
  } catch (e) {
    await nextTick();
    if (textRef.value) {
      textRef.value.focus();
      textRef.value.select();
      document.execCommand('copy');
    }
  }
  copied.value = true;
  setTimeout(() => { copied.value = false; }, 2000);
}
</script>

<style scoped>
/* body/#app 이 overflow: hidden 이라 이 화면이 직접 스크롤해야 한다 (CameraFinder.vue 와 같은 이유) */
.settings { height: 100dvh; overflow-y: auto; padding: 16px; box-sizing: border-box; text-align: left; color: #213547; }
.settings > * { max-width: 560px; margin-left: auto; margin-right: auto; }
.settings-head { margin-bottom: 12px; }
.settings-head h2 { margin: 8px 0 0; }
.back { font-size: 14px; color: #007bff; text-decoration: none; }
.menu { display: flex; flex-direction: column; background: #fff; border: 1px solid #ddd; border-radius: 8px; overflow: hidden; }
.menu-item { display: flex; align-items: center; gap: 12px; padding: 14px 16px; color: #222; text-decoration: none; font-weight: 400; }
.menu-item + .menu-item { border-top: 1px solid #eee; }
.menu-item:hover { background: #f5f8ff; color: #222; }
.menu-text { flex: 1; display: flex; flex-direction: column; gap: 2px; }
.menu-text strong { font-size: 15px; }
.menu-desc { font-size: 13px; color: #777; }
.chevron { font-size: 22px; color: #aaa; line-height: 1; }
.diag { box-sizing: border-box; margin-top: 16px; padding: 14px 16px; background: #fff; border: 1px solid #ddd; border-radius: 8px; }
.diag-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.diag-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.diag-actions button:disabled { opacity: 0.6; }
.diag-desc { margin: 6px 0 0; font-size: 13px; color: #777; }
.diag-error { margin: 6px 0 0; font-size: 13px; color: #c00; }
.diag textarea { width: 100%; margin-top: 8px; box-sizing: border-box; font-size: 12px; font-family: monospace; }
</style>
