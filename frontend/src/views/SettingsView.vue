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
        <button type="button" :disabled="loading" @click="copyDiagnostics">{{ copied ? '복사됨' : loading ? '불러오는 중...' : '진단 정보 복사' }}</button>
      </div>
      <p class="diag-desc">외부에서 영상이 보이지 않으면 이 내용을 복사해 문의할 때 함께 보내 주세요.</p>
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
.diag-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.diag-desc { margin: 6px 0 0; font-size: 13px; color: #777; }
.diag-error { margin: 6px 0 0; font-size: 13px; color: #c00; }
.diag textarea { width: 100%; margin-top: 8px; box-sizing: border-box; font-size: 12px; font-family: monospace; }
</style>
