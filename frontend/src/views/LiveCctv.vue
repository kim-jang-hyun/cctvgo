<template>
  <div class="page-wrapper">
    <div class="title-row">
      <h2>실시간 CCTV 스트리밍</h2>
      <!-- 휴대폰 1채널 뷰에서는 아래 카메라 선택 줄 끝에 둔다 -->
      <router-link v-if="!(isMobile && cameraList)" to="/settings" class="settings-link" aria-label="설정" title="설정">
        <SettingsIcon />
      </router-link>
    </div>

    <!-- 모바일: 한 화면에 1개 전체 화면 + 카메라 선택 리스트 -->
    <template v-if="isMobile && cameraList">
      <div class="mobile-video-wrap">
        <div class="video-label mobile-label">{{ currentMobileCamera?.name || '선택된 카메라' }}</div>
        <div v-if="currentMobileCamera && statusText(currentMobileCamera.id)" class="video-status">{{ statusText(currentMobileCamera.id) }}</div>
        <video
          v-if="currentMobileCamera?.stream != null"
          ref="mobileVideoRef"
          class="mobile-video"
          autoplay
          muted
          playsinline
          controls
        ></video>
      </div>
      <div class="mobile-tab-selector">
        <div class="tab-inner">
          <button
            v-for="(cam, i) in camerasWithUrl"
            :key="cam.id"
            class="tab-item"
            :class="{ active: selectedMobileIndex === i }"
            @click="selectedMobileIndex = i"
          >
            {{ cam.name || '카메라 ' + (i + 1) }}
          </button>
        </div>
        <router-link to="/settings" class="tab-settings" aria-label="설정" title="설정">
          <SettingsIcon />
        </router-link>
      </div>
    </template>

    <!-- 데스크톱: 그리드 뷰 -->
    <draggable
      v-else-if="cameraList"
      v-model="cameraList"
      item-key="id"
      class="video-grid"
      :style="{ gridTemplateColumns: `repeat(${gridColumns}, 1fr)` }"
      :sort="false"
    >
      <template #item="{ element, index }">
        <div class="video-container">
          <div class="video-label">{{ element.name }}</div>
          <div v-if="element.stream != null && statusText(element.id)" class="video-status">{{ statusText(element.id) }}</div>
          <video
            v-if="element.stream != null"
            :ref="el => videoElements[index] = el"
            class="video-player"
            :data-index="index"
            autoplay
            muted
            playsinline
            controls
          ></video>
        </div>
      </template>
    </draggable>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted, nextTick, watch } from 'vue';
import { connectStream } from '../webrtc';
import draggable from 'vuedraggable';
import SettingsIcon from '../components/SettingsIcon.vue';

// --- 상수 ---
const ROWS = 2;
const MIN_COLUMNS = 2;
const MOBILE_BREAKPOINT = 768;

// 연결 상태별 안내 문구 (재생 중이면 표시하지 않음)
const STATUS_TEXT = {
  connecting: '연결 중...',
  network: '이 네트워크 환경에서는 외부 시청이 불가능합니다',
  disconnected: '연결이 끊겼습니다. 다시 연결하는 중...',
  codec: '이 브라우저에서는 이 카메라 영상(H.265)을 재생할 수 없습니다',
  camera: '카메라가 응답하지 않습니다',
  signaling: '서버에 연결하지 못했습니다. 다시 시도하는 중...',
};

// --- 상태 ---
const cameraList = ref(null);
const error = ref(null);
let epoch = '';   // 채널 목록의 번호 체계 (서비스가 다시 시작하면 바뀐다)
let keepAliveTimer = null;
let reloading = null;
// 영상만 보고 있으면 HTTP 요청이 없어 로그인 세션(1시간)이 끝난다. 화면을 켜 두는 동안 주기적으로 목록을 받아 세션을 유지한다
const KEEPALIVE_MS = 15 * 60 * 1000;

const isMobile = ref(false);
const selectedMobileIndex = ref(0);
const mobileVideoRef = ref(null);
let mobileClose = null;

const closers = [];   // 데스크톱 칸별 연결 정리 함수
const videoElements = reactive([]);
const status = reactive({});   // 카메라 id → { state, reason }

const statusText = id => {
  const st = status[id];
  if (!st || st.state === 'playing') return '';
  return st.state === 'connecting' ? STATUS_TEXT.connecting : STATUS_TEXT[st.reason] || STATUS_TEXT.network;
};
const watchState = id => (state, detail = {}) => { status[id] = { state, reason: detail.reason }; };

// --- computed ---
const gridColumns = computed(() => {
  const n = cameraList.value?.length ?? 0;
  return n ? Math.max(MIN_COLUMNS, Math.ceil(n / ROWS)) : MIN_COLUMNS;
});

const camerasWithUrl = computed(() => (cameraList.value || []).filter(c => c?.stream != null));

const currentMobileCamera = computed(
  () => camerasWithUrl.value[selectedMobileIndex.value] ?? null
);

// --- API · 카메라 목록 ---
const getCameraList = async () => {
  const API_URL = '/api/get-channel-list';
  let channelList = [];
  error.value = null;

  try {
    const response = await fetch(API_URL);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(errorData.message || `Failed to get: ${response.status}`);
    }
    const data = await response.json();
    if (data.status !== 'success') {
      throw new Error(data.message || 'API responded with non-success status.');
    }
    console.log('채널 리스트:', data.channels);
    channelList = data.channels || [];
    epoch = data.epoch || '';
  } catch (err) {
    console.error('API call error:', err.message);
    error.value = err.message;
    channelList = [];
  }
  return channelList;
};

// channels: [{ name, stream }] — 카메라 번호(stream)는 서버가 정한다 (카메라를 지워도 다른 카메라의 번호는 그대로라 순번으로 계산하면 안 된다)
const initCameraList = (channels) => {
  if (error.value !== null) {
    console.error('initCameraList error: ', error.value);
    cameraList.value = [];
    return;
  }
  const cameraCount = channels.length;
  const columns = Math.max(MIN_COLUMNS, Math.ceil(cameraCount / ROWS));
  const totalSlots = ROWS * columns;

  cameraList.value = [];
  for (let i = 0; i < totalSlots; i++) {
    const hasCamera = i < cameraCount;
    cameraList.value.push({
      id: 'cam' + (i + 1),
      name: hasCamera ? channels[i].name : null,
      stream: hasCamera ? channels[i].stream : null,
    });
  }
  console.log(`cameraList가 ${cameraCount}개(그리드 ${columns}x${ROWS}=${totalSlots}칸)로 초기화되었습니다.`, cameraList.value);
};

// --- WebRTC · 플레이어 ---
function initMobilePlayer() {
  if (mobileClose) {
    mobileClose();
    mobileClose = null;
  }
  const cam = currentMobileCamera.value;
  if (!mobileVideoRef.value || cam?.stream == null) return;
  mobileClose = connectStream(mobileVideoRef.value, cam.stream, { epoch, onState: watchState(cam.id), onStale: reloadCameras });
}

function closeDesktopPlayers() {
  closers.forEach(close => close());
  closers.length = 0;
}

function initPlayers() {
  closeDesktopPlayers();

  if (isMobile.value) {
    initMobilePlayer();
    return;
  }
  if (mobileClose) {
    mobileClose();
    mobileClose = null;
  }

  cameraList.value.forEach((cam, index) => {
    const video = videoElements[index];
    if (!video || cam.stream == null) return;
    closers.push(connectStream(video, cam.stream, { epoch, onState: watchState(cam.id), onStale: reloadCameras }));
  });
}

// --- 모바일 감지 ---
// iOS Safari 는 화면을 돌렸을 때 resize 시점의 innerWidth 가 아직 이전 값일 수 있어,
// 회전 직후에도 정확한 미디어쿼리 change 이벤트로 판정한다 (resize 는 보조)
const mobileQuery = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`);

function checkMobile() {
  isMobile.value = mobileQuery.matches;
}

// --- watch ---
watch([selectedMobileIndex, currentMobileCamera], () => {
  if (isMobile.value) initMobilePlayer();
});

watch(isMobile, () => {
  nextTick(() => initPlayers());
});

// 서비스가 다시 시작했거나 카메라 목록이 바뀌었으면 목록을 다시 받아 칸을 다시 연결한다 (여러 칸이 동시에 알려도 한 번만)
function reloadCameras() {
  if (reloading) return reloading;
  reloading = (async () => {
    closeDesktopPlayers();
    if (mobileClose) {
      mobileClose();
      mobileClose = null;
    }
    const channels = await getCameraList();
    initCameraList(channels);
    await nextTick();
    initPlayers();
  })().finally(() => { reloading = null; });
  return reloading;
}

async function keepAlive() {
  try {
    const res = await fetch('/api/get-channel-list');
    if (res.redirected) return;   // 이미 세션이 끝났으면 다음 연결 시도에서 로그인 화면으로 간다
    const data = await res.json();
    if (data.epoch && data.epoch !== epoch) reloadCameras();
  } catch (e) { /* 다음 주기에 다시 */ }
}

// --- lifecycle ---
onMounted(async () => {
  checkMobile();
  mobileQuery.addEventListener('change', checkMobile);
  window.addEventListener('resize', checkMobile);

  const channels = await getCameraList();
  initCameraList(channels);

  await nextTick();
  initPlayers();
  keepAliveTimer = setInterval(keepAlive, KEEPALIVE_MS);
});

onUnmounted(() => {
  clearInterval(keepAliveTimer);
  mobileQuery.removeEventListener('change', checkMobile);
  window.removeEventListener('resize', checkMobile);
  closeDesktopPlayers();
  if (mobileClose) {
    mobileClose();
    mobileClose = null;
  }
});
</script>

<style scoped>
/* --- 페이지 --- */
.page-wrapper {
  position: relative;
  width: 100%;
  height: 100dvh;
  margin: 0;
  padding: 5px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 제목과 설정 아이콘을 같은 높이에 두려고 한 줄로 묶는다. 여백은 h2 기본 위 여백 + 기존 아래 10px */
.title-row {
  position: relative;
  margin: 20px 0 10px;
}

h2 {
  width: 100%;
  margin: 0;
  color: #213547;   /* body 배경이 항상 흰색이라 다크 모드 기본 글자색(흰색)을 쓰면 안 보인다 */
  word-break: keep-all;
  white-space: nowrap;
  overflow: visible;
  text-align: center;
}

/* 설치할 때만 쓰는 설정이라 제목 줄 오른쪽 끝에 아이콘만 작게 둔다 */
.settings-link {
  position: absolute;
  top: 50%;
  right: 8px;
  transform: translateY(-50%);
  z-index: 10;
  display: flex;
  padding: 4px;
  color: #888;
}

.settings-link:hover {
  color: #007bff;
}

/* 연결 상태 안내 (재생 중에는 숨김) */
.video-status {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
  color: #ddd;
  font-size: 14px;
  text-align: center;
  word-break: keep-all;
  pointer-events: none;
}

/* --- 데스크톱 그리드 --- */
.video-grid {
  flex: 1;
  display: grid;
  grid-template-rows: repeat(2, 1fr);
  gap: 6px;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.video-container {
  position: relative;
  width: 100%;
  height: 100%;
  background: black;
  overflow: hidden;
  cursor: pointer;
  border: 2px solid transparent;
  transition: border-color 0.2s;
}

.video-container:hover {
  border-color: #007bff;
}

.video-player {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.video-label {
  position: absolute;
  top: 4px;
  left: 8px;
  padding: 2px 6px;
  background: rgba(0, 0, 0, 0.6);
  color: white;
  font-size: 12px;
  border-radius: 4px;
  z-index: 1;
  cursor: pointer;
}

/* 터치 기기(가로모드 휴대폰 등)에서는 iOS 컨트롤 좌측 상단의 전체보기 버튼을 가리지 않도록
   이름표를 영상 위 별도 줄에 둔다. 컨트롤이 아래에 있는 PC 에서는 영상 위에 겹쳐 둔다 */
@media (hover: none) and (pointer: coarse) {
  .video-container {
    display: flex;
    flex-direction: column;
  }

  .video-container .video-label {
    position: static;
    align-self: flex-start;
    margin: 2px 4px;
  }

  .video-player {
    flex: 1;
    min-height: 0;
    height: auto;
  }
}

/* --- 모바일 --- */
.mobile-video-wrap {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  width: 100%;
  min-height: 0;
  background: #000;
}

/* 영상 위에 겹치면 iOS 컨트롤 좌측 상단의 전체보기 버튼을 가리므로 영상 위 별도 줄에 둔다 */
.mobile-label {
  position: static;
  align-self: flex-start;
  margin: 6px 8px;
}

.mobile-video {
  flex: 1;
  width: 100%;
  min-height: 0;
  object-fit: contain;
}

.mobile-tab-selector {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  width: 100%;
  background: #1a1a1a;
  padding: 10px 0;
  border-top: 1px solid #333;
}

.tab-inner {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-wrap: nowrap;
  overflow-x: auto;
  overflow-y: hidden;
  white-space: nowrap;
  padding: 0 10px;
  -webkit-overflow-scrolling: touch;
  gap: 8px;
}

/* 카메라 탭이 옆으로 스크롤돼도 오른쪽 끝에 고정 */
.tab-settings {
  flex-shrink: 0;
  display: flex;
  padding: 6px 12px 6px 4px;
  color: #aaa;
}

.tab-inner::-webkit-scrollbar {
  display: none;
}

.tab-item {
  flex-shrink: 0;
  padding: 8px 16px;
  background: #2a2a2a;
  color: #aaa;
  border: 1px solid #444;
  border-radius: 20px;
  font-size: 14px;
  white-space: nowrap;
  transition: all 0.2s ease;
}

.tab-item.active {
  background: #007bff;
  color: #fff;
  border-color: #007bff;
  font-weight: bold;
}
</style>
