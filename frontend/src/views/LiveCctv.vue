<template>
  <div class="page-wrapper">
    <div class="header-container">
      <div class="header-left"></div>

      <h2 class="main-title">실시간 CCTV 스트리밍</h2>

      <div class="header-right">
        <button class="btn-restart" @click="showRestartModal = true">
          <span class="restart-icon">↻</span>
          <span class="restart-text">시스템 재시작</span>
        </button>
      </div>
    </div>

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

    <div v-if="showRestartModal" class="modal-overlay">
      <div class="modal-content">
        <h3>시스템 재시작</h3>
        <p>FFmpeg와 터널링을 포함한<br>모든 프로세스를 재시작하시겠습니까?</p>
        <div class="modal-btns">
          <button class="btn-confirm" @click="handleRestart">확인</button>
          <button class="btn-cancel" @click="showRestartModal = false">취소</button>
        </div>
      </div>
    </div>

    <div v-if="isRestarting" class="restart-loading-overlay">
      <div class="loader"></div>
      <p>시스템 재시작 중입니다...<br>잠시 후 자동으로 새로고침됩니다.</p>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, nextTick } from 'vue';
import Hls from 'hls.js';
import draggable from 'vuedraggable';

// 상태 변수 정의
const showRestartModal = ref(false); // 모달 표시 여부
const isRestarting = ref(false);     // 로딩 표시 여부

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

const handleRestart = async () => {
  showRestartModal.value = false;
  isRestarting.value = true;

  try {
    // 백엔드의 재시작 API 호출 (cctvgo.bat 실행용)
    const response = await fetch('/api/restart', { method: 'POST' });
    
    // 배치 파일이 모두 정리하고 다시 실행될 때까지 충분한 시간(30초) 대기
    setTimeout(() => {
      window.location.reload();
    }, 30000);
  } catch (err) {
    alert('재시작 명령 전달에 실패했습니다: ' + err.message);
    isRestarting.value = false;
  }
};

</script>

<style scoped>
/* 헤더 전체 컨테이너 */
.header-container {
  display: flex;
  justify-content: space-between; /* 양 끝과 중앙 배치 */
  align-items: center;
  padding: 10px 15px; /* 상하 10px, 좌우 15px 여백 */
  background: #fff;
  position: relative;
  height: 60px; /* 헤더 높이 고정 */
}

.header-left {
  flex: 1; /* 왼쪽 공간 차지 */
}

/* 제목: 화면의 정중앙 고정 */
.main-title {
  flex: 2; /* 중앙 비중 확대 */
  text-align: center;
  margin: 0;
  font-size: 1.5rem;
  font-weight: 700;
  color: #333;
  white-space: nowrap; /* 제목 줄바꿈 방지 */
}

.header-right {
  flex: 1; /* 오른쪽 공간 차지 */
  display: flex;
  justify-content: flex-end; /* 버튼을 오른쪽 끝으로 밀착 */
}

/* 시스템 재시작 버튼 스타일링 */
.btn-restart {
  display: flex;
  align-items: center;
  gap: 6px; /* 아이콘과 텍스트 사이 간격 */
  background-color: #f8f9fa; /* 너무 튀지 않는 연한 회색 */
  color: #c0392b; /* 텍스트만 강조색 (빨간색) */
  border: 1.5px solid #e74c3c;
  padding: 6px 12px;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap; /* 텍스트가 두 줄로 나오는 것 방지 */
  transition: all 0.2s ease;
  font-weight: 600;
}

.btn-restart:hover {
  background-color: #e74c3c;
  color: #fff; /* 호버 시에만 반전 */
}

/* 아이콘 스타일 */
.restart-icon {
  font-size: 18px;
  font-weight: bold;
  line-height: 1;
}

.restart-text {
  font-size: 13px;
}

/* 모달 및 로딩 화면 전체 화면 고정 */
.modal-overlay, .restart-loading-overlay {
  position: fixed; /* 브라우저 화면 기준 고정 */
  top: 0;
  left: 0;
  width: 100vw;    /* 뷰포트 가로 전체 */
  height: 100vh;   /* 뷰포트 세로 전체 */
  background: rgba(0, 0, 0, 0.85); /* 문구가 잘 보이도록 배경을 더 어둡게 */
  display: flex;
  flex-direction: column; /* 아이콘과 문구를 세로로 배치 */
  justify-content: center; /* 가로 중앙 */
  align-items: center;     /* 세로 중앙 */
  z-index: 99999;          /* 최상단에 표시 */
}

/* 로딩 문구 스타일 (잘 보이도록 수정) */
.restart-loading-overlay p {
  color: #ffffff;
  font-size: 18px;
  font-weight: bold;
  margin-top: 20px;
  text-align: center;
  line-height: 1.6;
  text-shadow: 1px 1px 4px rgba(0,0,0,0.5); /* 글씨 뒤에 그림자를 주어 가독성 확보 */
}

.modal-content {
  background: white;
  padding: 25px;
  border-radius: 12px;
  text-align: center;
  min-width: 280px;
}

.modal-btns {
  margin-top: 20px;
  display: flex;
  justify-content: center;
  gap: 10px;
}

.btn-confirm { background: #e74c3c; color: white; border: none; padding: 8px 20px; border-radius: 4px; cursor: pointer; }
.btn-cancel { background: #95a5a6; color: white; border: none; padding: 8px 20px; border-radius: 4px; cursor: pointer; }

/* 뺑글뺑글 로더 크기 및 색상 조정 */
.loader {
  border: 6px solid #f3f3f3;
  border-top: 6px solid #3498db;
  border-radius: 50%;
  width: 60px; /* 크기를 조금 더 키움 */
  height: 60px;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

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

.main-title {
  flex: 2;
  text-align: center;
  margin: 0;
  font-size: 1.5rem;
  font-weight: 700;
  color: #333;
  white-space: nowrap;
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
