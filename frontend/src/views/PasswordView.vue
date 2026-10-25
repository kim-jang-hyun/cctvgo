<template>
  <div class="settings">
    <header class="settings-head">
      <router-link to="/settings" class="back">← 설정으로</router-link>
      <h2>비밀번호 변경</h2>
    </header>

    <section class="card">
      <form @submit.prevent="changePassword">
        <label for="current-password">현재 비밀번호</label>
        <input id="current-password" v-model="currentPassword" type="password" autocomplete="current-password" />
        <label for="new-password">새 비밀번호 ({{ MIN_LENGTH }}~{{ MAX_LENGTH }}자)</label>
        <input id="new-password" v-model="newPassword" type="password" autocomplete="new-password" :maxlength="MAX_LENGTH" />
        <label for="confirm-password">새 비밀번호 확인</label>
        <input id="confirm-password" v-model="confirmPassword" type="password" autocomplete="new-password" :maxlength="MAX_LENGTH" />
        <p class="notice">비밀번호를 바꾸면 이 기기를 뺀 다른 휴대폰과 PC는 모두 로그아웃됩니다.</p>
        <p v-if="error" class="error">{{ error }}</p>
        <p v-if="done" class="ok">비밀번호를 변경했습니다.</p>
        <button type="submit" class="primary" :disabled="saving || !currentPassword || !newPassword">
          {{ saving ? '변경 중...' : '비밀번호 변경' }}
        </button>
      </form>
    </section>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';

// backend/settings/password-store.js 와 같은 값
const MIN_LENGTH = 4;
const MAX_LENGTH = 64;

const router = useRouter();

const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const saving = ref(false);
const error = ref('');
const done = ref(false);

async function changePassword() {
  error.value = '';
  done.value = false;
  if (newPassword.value.length < MIN_LENGTH) {
    error.value = `새 비밀번호는 ${MIN_LENGTH}자 이상으로 입력하세요.`;
    return;
  }
  if (newPassword.value !== confirmPassword.value) {
    error.value = '새 비밀번호와 확인 값이 다릅니다.';
    return;
  }

  saving.value = true;
  try {
    const res = await fetch('/api/settings/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: currentPassword.value, newPassword: newPassword.value }),
    });
    let finalPath = '';
    try { finalPath = new URL(res.url).pathname; } catch (e) { /* url 없음 */ }
    if (res.redirected || finalPath === '/login') {
      router.push('/login');   // 세션 만료
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      error.value = data.message || `요청에 실패했습니다. (${res.status})`;
      return;
    }
    done.value = true;
    currentPassword.value = '';
    newPassword.value = '';
    confirmPassword.value = '';
  } catch (e) {
    error.value = '서버에 연결할 수 없습니다.';
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
/* body/#app 이 overflow: hidden 이라 이 화면이 직접 스크롤해야 한다 (CameraFinder.vue 와 같은 이유) */
.settings { height: 100dvh; overflow-y: auto; padding: 16px; box-sizing: border-box; text-align: left; color: #213547; }
.settings > * { max-width: 560px; margin-left: auto; margin-right: auto; }
.settings-head { margin-bottom: 12px; }
.settings-head h2 { margin: 8px 0 0; }
.back { font-size: 14px; color: #007bff; text-decoration: none; }
.card { background: #fff; color: #222; border: 1px solid #ddd; border-radius: 8px; padding: 16px; display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
form { display: flex; flex-direction: column; gap: 8px; }
label { font-size: 13px; font-weight: 600; margin-top: 4px; }
input { width: 100%; box-sizing: border-box; padding: 8px 10px; font-size: 15px; border: 1px solid #bbb; border-radius: 6px; }
button { padding: 8px 14px; font-size: 14px; border: 1px solid #bbb; background: #f5f5f5; color: #222; border-radius: 6px; cursor: pointer; text-decoration: none; display: inline-block; align-self: flex-start; }
button.primary { background: #007bff; border-color: #007bff; color: #fff; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
.notice { background: #fff8e1; border: 1px solid #ffe08a; border-radius: 6px; padding: 8px; font-size: 13px; margin: 4px 0; }
.error { color: #c62828; margin: 0; word-break: keep-all; }
.ok { color: #2e7d32; font-weight: 700; margin: 0; }
</style>
