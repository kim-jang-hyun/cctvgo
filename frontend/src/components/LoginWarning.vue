<template>
  <!-- 카메라 로그인 실패 경고. CCTVGO 는 다시 시도를 막지 않으므로(2026-10-31 결정) 카메라가 잠길 수 있다는 것을 알린다 -->
  <div class="login-warning" role="note">
    <span class="icon" aria-hidden="true">⚠</span>
    <div class="body">
      <strong>비밀번호를 여러 번 틀리면 카메라가 잠길 수 있습니다</strong>
      <p>잠기는 동안 CCTVGO에서 이 카메라 영상이 나오지 않고, 카메라에 따라 녹화기나 휴대폰 앱의 접속도 함께 막힐 수 있습니다. 시도하기 전에 카메라 웹페이지에 이 아이디/비밀번호로 로그인되는지 확인하세요.</p>
    </div>
  </div>
</template>

<style scoped>
.login-warning {
  display: flex;
  gap: 10px;
  margin: 12px 0 4px;
  padding: 10px 12px;
  background: #fff8e6;
  border: 1px solid #f3dfa8;
  border-left: 4px solid #e8a317;
  border-radius: 6px;
  color: #5c4300;
  text-align: left;
}
.icon { font-size: 16px; line-height: 1.4; color: #c98400; }
.body strong { display: block; font-size: 14px; margin-bottom: 2px; }
.body p { margin: 0; font-size: 13px; line-height: 1.5; word-break: keep-all; }
</style>
