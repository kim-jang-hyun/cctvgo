<template>
  <div class="login-container">
    <div class="login-box">
      <div class="logo">CCTVGO</div>
      <p class="subtitle">Welcome to <span>cctvgo.app</span></p>
      <form @submit.prevent="login">
        <input
          v-model="password"
          type="password"
          placeholder="Enter password"
          class="input"
        />
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <button type="submit" class="button" :disabled="busy">Login</button>
      </form>
      <p class="footer">© 2025 CCTVGO. All rights reserved.</p>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'

const password = ref('')
const error = ref('')
const busy = ref(false)
const router = useRouter()

// 틀렸을 때와 여러 번 틀려 잠시 막혔을 때(429) 서버가 보낸 안내를 그대로 보여 준다
const login = async () => {
  busy.value = true
  error.value = ''
  try {
    const res = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: password.value })
    })
    if (res.ok) {
      router.push('/')
      return
    }
    const text = (await res.text().catch(() => '')).trim()
    error.value = (res.status === 401 || res.status === 429) && text ? text : `로그인하지 못했습니다. (${res.status})`
    if (res.status === 401) password.value = ''
  } catch (e) {
    error.value = '서버에 연결하지 못했습니다. 잠시 뒤 다시 시도하세요.'
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
/* 중앙 정렬 컨테이너 */
.login-container {
  height: 100vh;   /* 화면 전체 높이 */
  display: flex;
  justify-content: center;      /* 가로 중앙 */
  align-items: center;          /* 세로 중앙 */
  padding: 16px;
  box-sizing: border-box;
  background: transparent;
}

/* 로그인 박스 */
.login-box {
  background: rgba(26, 26, 26, 0.85);
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 16px;
  padding: 40px 24px;
  width: 100%;
  max-width: 360px;
  min-height: 400px;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(12px);
  text-align: center;
  color: white;

  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  box-sizing: border-box;
}

.logo {
  font-size: 32px;
  font-weight: bold;
  letter-spacing: 1px;
  color: #ffffff;
  margin-bottom: 8px;
}

.subtitle {
  font-size: 14px;
  margin-bottom: 24px;
  color: #cccccc;
}

.subtitle span {
  color: #ffd700;
  font-weight: 500;
}

.input,
.button {
  width: 100%;
  box-sizing: border-box;
  padding: 12px;
  border-radius: 8px;
  border: none;
  font-size: 16px;   /* iOS 는 16px 보다 작은 입력 칸을 누르면 화면을 확대하고, 로그인 뒤에도 확대가 남는다 */
}

.input {
  margin-bottom: 20px;
  background: rgba(255, 255, 255, 0.125);
  color: white;
}

.input::placeholder {
  color: #dddddd;
}

.button {
  margin-bottom: 20px;
  background-color: #ffd700;
  color: black;
  font-weight: bold;
  cursor: pointer;
  transition: background 0.3s;
}

.button:hover {
  background-color: #ffcd00;
}

.button:disabled {
  opacity: 0.6;
  cursor: wait;
}

.error {
  margin: -8px 0 16px;
  font-size: 14px;
  color: #ff8a80;
  word-break: keep-all;
}

.footer {
  font-size: 12px;
  color: #aaaaaa;
  margin-top: auto;
}

/* 모바일 대응 */
@media (max-width: 768px) {
  .login-container {
    align-items: flex-start;    /* 화면 위쪽에 배치 */
    padding-top: 80px;          /* 위쪽 여백 */
  }
}
</style>
