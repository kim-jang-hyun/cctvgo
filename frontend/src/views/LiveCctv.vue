<template>
  <div class="page-wrapper">
    <h2>실시간 CCTV 스트리밍</h2>

    <!-- 모바일: 한 화면에 1개 전체 화면 + 카메라 선택 리스트 -->
    <template v-if="isMobile && cameraList">
      <div class="mobile-video-wrap">
        <div class="video-label mobile-label">{{ currentMobileCamera?.name || '선택된 카메라' }}</div>
        <video
          v-if="currentMobileCamera?.url"
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
          <video
            v-if="element.url !== null"
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
import Hls from 'hls.js';
import draggable from 'vuedraggable';

// --- 상수 ---
const ROWS = 2;
const MIN_COLUMNS = 2;
const MOBILE_BREAKPOINT = 768;

const hlsConfig = {
  enableWorker: true,
  lowLatencyMode: true,
  backBufferLength: 0,
  maxBufferLength: 4,
  maxMaxBufferLength: 10,
  liveSyncDurationCount: 1.5,
  liveMaxLatencyDurationCount: 3,
  manifestLoadingMaxRetry: 10,
  levelLoadingMaxRetry: 10,
};

// --- 상태 ---
const cameraList = ref(null);
const error = ref(null);

const isMobile = ref(false);
const selectedMobileIndex = ref(0);
const mobileVideoRef = ref(null);
let mobileHlsInstance = null;

const hlsInstances = [];
const videoElements = reactive([]);

// --- computed ---
const gridColumns = computed(() => {
  const n = cameraList.value?.length ?? 0;
  return n ? Math.max(MIN_COLUMNS, Math.ceil(n / ROWS)) : MIN_COLUMNS;
});

const camerasWithUrl = computed(() => (cameraList.value || []).filter(c => c?.url));

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
    console.log('채널 리스트:', data.channelList);
    channelList = data.channelList || [];
  } catch (err) {
    console.error('API call error:', err.message);
    error.value = err.message;
    channelList = [];
  }
  return channelList;
};

const initCameraList = (cameraNameList) => {
  if (error.value !== null) {
    console.error('initCameraList error: ', error.value);
    cameraList.value = [];
    return;
  }
  const cameraCount = cameraNameList.length;
  const columns = Math.max(MIN_COLUMNS, Math.ceil(cameraCount / ROWS));
  const totalSlots = ROWS * columns;

  cameraList.value = [];
  for (let i = 0; i < totalSlots; i++) {
    const hasCamera = i < cameraCount;
    cameraList.value.push({
      id: 'cam' + (i + 1),
      name: hasCamera ? cameraNameList[i] : null,
      url: hasCamera ? `/hls/stream${i + 1}/stream${i + 1}.m3u8` : null,
    });
  }
  console.log(`cameraList가 ${cameraCount}개(그리드 ${columns}x${ROWS}=${totalSlots}칸)로 초기화되었습니다.`, cameraList.value);
};

// --- HLS · 플레이어 ---
function initMobilePlayer() {
  if (!mobileVideoRef.value || !currentMobileCamera.value?.url) return;
  if (mobileHlsInstance) {
    mobileHlsInstance.destroy();
    mobileHlsInstance = null;
  }
  const video = mobileVideoRef.value;
  const url = currentMobileCamera.value.url;
  if (Hls.isSupported()) {
    const hls = new Hls(hlsConfig);
    hls.loadSource(url);
    hls.attachMedia(video);
    mobileHlsInstance = hls;
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
  }
}

function initPlayers() {
  hlsInstances.forEach(hls => hls.destroy());
  hlsInstances.length = 0;

  if (isMobile.value) {
    initMobilePlayer();
    return;
  }

  cameraList.value.forEach((stream, index) => {
    const video = videoElements[index];
    if (!video) return;
    if (stream.url == null) {
      video.src = '';
      return;
    }
    if (Hls.isSupported()) {
      const hls = new Hls(hlsConfig);
      hls.loadSource(stream.url);
      hls.attachMedia(video);
      hlsInstances.push(hls);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = stream.url;
    } else {
      alert(`HLS를 지원하지 않는 브라우저입니다. (Stream: ${stream.name})`);
    }
  });
}

// --- 모바일 감지 ---
function checkMobile() {
  isMobile.value = window.innerWidth <= MOBILE_BREAKPOINT;
}

// --- watch ---
watch([selectedMobileIndex, currentMobileCamera], () => {
  if (isMobile.value) initMobilePlayer();
});

watch(isMobile, () => {
  nextTick(() => initPlayers());
});

// --- lifecycle ---
onMounted(async () => {
  checkMobile();
  window.addEventListener('resize', checkMobile);

  const cameraNameList = await getCameraList();
  initCameraList(cameraNameList);

  await nextTick();
  initPlayers();
});

onUnmounted(() => {
  window.removeEventListener('resize', checkMobile);
  if (mobileHlsInstance) {
    mobileHlsInstance.destroy();
    mobileHlsInstance = null;
  }
});
</script>

<style scoped>
/* --- 페이지 --- */
.page-wrapper {
  width: 100%;
  height: 100dvh;
  margin: 0;
  padding: 5px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

h2 {
  width: 100%;
  margin-bottom: 10px;
  word-break: keep-all;
  white-space: nowrap;
  overflow: visible;
  text-align: center;
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

/* --- 모바일 --- */
.mobile-video-wrap {
  flex: 1;
  position: relative;
  width: 100%;
  min-height: 0;
  background: #000;
}

.mobile-label {
  position: absolute;
  top: 8px;
  left: 12px;
  z-index: 1;
}

.mobile-video {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.mobile-tab-selector {
  flex-shrink: 0;
  width: 100%;
  background: #1a1a1a;
  padding: 10px 0;
  border-top: 1px solid #333;
}

.tab-inner {
  display: flex;
  flex-wrap: nowrap;
  overflow-x: auto;
  overflow-y: hidden;
  white-space: nowrap;
  padding: 0 10px;
  -webkit-overflow-scrolling: touch;
  gap: 8px;
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
