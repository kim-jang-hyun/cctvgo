<template>
  <div class="settings">
    <header class="settings-head">
      <router-link to="/" class="back">← 영상 화면으로</router-link>
      <h2>설정</h2>
    </header>

    <!-- 기능마다 별도 화면으로 들어가는 메뉴 -->
    <nav class="menu">
      <router-link to="/finder" class="menu-item">
        <span class="menu-text">
          <strong>카메라 주소 찾기</strong>
          <span class="menu-desc">카메라의 RTSP 주소를 찾아 cctv.txt에 저장합니다</span>
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
  </div>
</template>

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
</style>
