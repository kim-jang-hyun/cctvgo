<template>
  <div class="page-wrapper">
    <h2>실시간 CCTV 스트리밍</h2>

    <!-- 채널 뷰어 (드래그앤드랍 가능) -->
    <draggable
      v-if="cameraList"
      v-model="cameraList"
      item-key="id"
      class="video-grid"
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
import { ref, reactive, onMounted, nextTick } from 'vue';
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
 * @param {Array<string>} cameraNameList - 백엔드에서 받아온 카메라 이름 목록
 */
const initCameraList = (cameraNameList) => {
  const cameraCount = cameraNameList.length;
  cameraList.value = JSON.parse(JSON.stringify(DEFAULT_CAMERA_LIST));

  if (error.value !== null) {
    console.error('initCameraList error: ', error.value);
    cameraList.value = [];
    return;
  }

  if (cameraCount > DEFAULT_CAMERA_LIST.length) {
    console.error('initCameraList error: ', cameraCount);
    cameraList.value = [];
    return;
  }

  for (let i = 0; i < DEFAULT_CAMERA_LIST.length; ++i) {

    let isValidCamera = (i < cameraCount);
    if (isValidCamera) {
      cameraList.value[i].name = cameraNameList[i];
    }
    else {
      cameraList.value[i].name = null;
      cameraList.value[i].url = null;
      cameraList.value[i].viewIndex = null;
    }
  }
  console.log(`cameraList가 ${cameraCount}개로 초기화되었습니다.`, cameraList.value);
};

// 카메라 리스트
const DEFAULT_CAMERA_LIST = [
  { id: 'cam1', name: 'Camera 1', url: '/hls/stream1/stream1.m3u8', viewIndex: 0 },
  { id: 'cam2', name: 'Camera 2', url: '/hls/stream2/stream2.m3u8', viewIndex: 1 },
  { id: 'cam3', name: 'Camera 3', url: '/hls/stream3/stream3.m3u8', viewIndex: 2 },
  { id: 'cam4', name: 'Camera 4', url: '/hls/stream4/stream4.m3u8', viewIndex: 3 },
];
const cameraList = ref(null);

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
            const hls = new Hls();
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

/* CCTV 영상 4분할 그리드 */
.video-grid {
  flex: 1; /* 상단 제목과 카메라 리스트 제외한 남은 공간 전부 차지 */
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  grid-template-rows: repeat(2, 1fr);
  gap: 6px;
  width: 100%;
  height: 100%; /* 부모 높이 모두 채움 */
  overflow: hidden; /* 스크롤 안 생기게 */
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
