<template>
  <div class="page-wrapper">
    <h2>실시간 CCTV 스트리밍</h2>

    <!-- 채널 뷰어 (드래그앤드랍 가능) -->
    <draggable
      v-if="cameraList"
      v-model="cameraList"
      item-key="id"
      class="video-grid"
      :style="{ gridTemplateColumns: `repeat(${gridColumns}, 1fr)` }"
      :sort="false"
    >
      <template #item="{ element, index }">
        <!-- 모바일에서는 선택된 채널만 표시 -->
        <div
          class="video-container"
        >
          <!-- 채널명 표시 -->
          <div class="video-label">
            {{ element.name }}
          </div>

          <!-- 비디오 -->
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
import { ref, reactive, computed, onMounted, nextTick } from 'vue';

const ROWS = 2;           // 행은 항상 2개
const MIN_COLUMNS = 2;   // 1~4대는 2열, 5대 이상은 열 추가
import Hls from 'hls.js';
import draggable from 'vuedraggable';

// 상태 변수 정의
const loading = ref(true);
const error = ref(null);

/**
 * 백엔드에서 카메라 리스트를 가져오는 비동기 함수
 * @returns {Array<string>} 카메라 이름 목록
 */
const getCameraList = async () => {
    const API_URL = '/api/get-channel-list'; 
    let channelList = []; // 로컬 변수 선언

    loading.value = true; // 로딩 시작
    error.value = null;   // 에러 초기화

    try {
        // 1. await fetch()로 응답 객체를 바로 받습니다.
        const response = await fetch(API_URL);

        // 2. HTTP 4xx, 5xx 에러 처리
        if (!response.ok) {
            // 서버에서 에러 메시지를 JSON 형태로 보냈을 경우 처리
            const errorData = await response.json().catch(() => ({ message: response.statusText }));
            // 오류를 throw하여 catch 블록으로 이동
            throw new Error(errorData.message || `Failed to get: ${response.status}`);
        }
        
        // 3. 응답 데이터를 JSON으로 파싱
        const data = await response.json();

        // 4. 백엔드의 status 필드 확인 (선택적)
        if (data.status !== 'success') {
            throw new Error(data.message || 'API responded with non-success status.');
        }

        // 5. 성공적으로 데이터를 받으면 channelList 업데이트
        console.log('채널 리스트:', data.channelList); // ex) ['거실', '안방']
        channelList = data.channelList || []; 

      } catch (err) {
        // 네트워크 오류 또는 throw된 오류 처리
        console.error('API call error:', err.message);
        error.value = err.message;
        // 오류 발생 시 빈 배열 반환
        channelList = []; 
      } finally {
        loading.value = false; // 로딩 완료
    }

    return channelList; // 로컬 변수 반환
};

/**
 * 행은 항상 2개. 1~4대: 2열(2x2), 5대 이상: 열만 추가 (2x3, 2x4, …)
 * @param {Array<string>} cameraNameList - 백엔드에서 받아온 카메라 이름 목록
 */
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
      viewIndex: i,
    });
  }
  console.log(`cameraList가 ${cameraCount}개(그리드 ${columns}x${ROWS}=${totalSlots}칸)로 초기화되었습니다.`, cameraList.value);
};

const cameraList = ref(null);

/** 그리드 열 수: 1~4대는 2열, 5대 이상은 ceil(개수/2)열 */
const gridColumns = computed(() => {
  const n = cameraList.value?.length ?? 0;
  return n ? Math.max(MIN_COLUMNS, Math.ceil(n / ROWS)) : MIN_COLUMNS;
});

// HLS 인스턴스와 비디오 태그 ref
const hlsInstances = [];
const videoElements = reactive([]);

// HLS 플레이어 초기화
const initPlayers = () => {
    hlsInstances.forEach(hls => hls.destroy());
    hlsInstances.length = 0;

    cameraList.value.forEach((stream, index) => {
        const video = videoElements[index];
        if (!video) return;

        // 💡 빈 채널(플레이스홀더)이면 스트림 로드를 건너뜁니다.
        if (stream.url === null || stream.url === undefined) {
            video.src = ''; // 비디오 소스 제거
            return;
        }

        if (Hls.isSupported()) {
          const hls = new Hls({
                enableWorker: true,
                lowLatencyMode: true,           // 저지연 모드 활성화
                backBufferLength: 0,            // 지나간 버퍼 즉시 제거
                maxBufferLength: 4,             // 최대 버퍼 길이를 짧게 (기본 30초 -> 4초)
                maxMaxBufferLength: 10,
                liveSyncDurationCount: 1.5,     // 최신 세그먼트와 재생 시점의 거리 (매우 중요)
                liveMaxLatencyDurationCount: 3, // 허용하는 최대 지연 세그먼트 수
                manifestLoadingMaxRetry: 10,
                levelLoadingMaxRetry: 10,
          });
          
          hls.loadSource(stream.url);
          hls.attachMedia(video);
          hlsInstances.push(hls);
          
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = stream.url;
        } else {
            alert(`HLS를 지원하지 않는 브라우저입니다. (Stream: ${stream.name})`);
        }
    });
};

onMounted(async () => {
  const cameraNameList = await getCameraList();
  initCameraList(cameraNameList);

  await nextTick();
  initPlayers();
});

</script>

<style scoped>
/* 전체 페이지 래퍼 */
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

/* 상단 제목 */
h2 {
  width: 100%;
  margin-bottom: 10px;
  word-break: keep-all;
  white-space: nowrap;
  overflow: visible;
  text-align: center;
}

/* CCTV 영상 그리드: 행 2개 고정, 열은 카메라 수에 따라 동적 (1~4대=2열, 5대 이상=열 추가) */
.video-grid {
  flex: 1;
  display: grid;
  grid-template-rows: repeat(2, 1fr);
  /* grid-template-columns는 :style로 동적 적용 */
  gap: 6px;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

/* 각각 영상 컨테이너 */
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

.video-container.highlight {
  border: 2px solid #007bff;
  box-shadow: 0 0 12px rgba(0, 123, 255, 0.5);
}

/* 영상 태그 */
.video-player {
  width: 100%;
  height: 100%;
  object-fit: cover; /* 영상 꽉 채우기 */
}

/* 영상 레이블 (채널명) */
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

/* fade transition 효과 */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.4s;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

</style>
