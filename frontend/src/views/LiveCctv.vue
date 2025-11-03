<template>
  <div class="page-wrapper">
    <h2>실시간 CCTV 스트리밍</h2>

    <!-- 채널 뷰어 (드래그앤드랍 가능) -->
    <draggable
      v-model="activeStreams"
      item-key="id"
      class="video-grid"
      :group="{ name: 'channels', pull: true, put: true }"
      @end="onDragEnd"
      @click.stop
    >
      <template #item="{ element, index }">
        <!-- 모바일에서는 선택된 채널만 표시 -->
        <div
          v-if="!isMobile || selectedCameraChipButton?.url === element.url"
          class="video-container"
          :class="{ 
            highlight: selectedCameraChipButton !== null,
            // 💡 빈 채널일 때 배경색 변경
            'empty-channel': element.url === null 
          }"
          @click="assignSelectedCameraChipButtonToCameraView(index)"
        >
          <!-- 채널명 표시 및 수정 -->
          <div class="video-label" @click.stop="startEditing(index, element.name)">
            <template v-if="editingIndex === index  && element.url !== null">
              <input
                v-model="editedName"
                @blur="finishEditing(index)"
                @keyup.enter="finishEditing(index)"
                class="video-name-input"
                autofocus
              />
            </template>
            <template v-else>
              {{ element.name }}
            </template>
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

    <!-- 카메라 리스트 (칩 스타일) -->
    <div class="camera-list" @click.stop>
      <div
        v-for="cam in cameraList"
        :key="cam.id"
        class="camera-chip"
        :class="{ selected: selectedCameraChipButton && selectedCameraChipButton.id === cam.id }"
        @click="selectCameraChipButton(cam)"
      >
        {{ cam.name }}
      </div>
    </div>
  </div>

  <!-- 하단 메시지 -->
  <transition name="fade">
    <div v-if="showMessage" class="assign-message">
      영상을 표시할 영역을 선택해 주세요.
    </div>
  </transition>
</template>

<script setup>
import { ref, reactive, onMounted, nextTick, onBeforeUnmount, computed } from 'vue';
import Hls from 'hls.js';
import draggable from 'vuedraggable';

// 상태 변수 정의
const GET_CAMERA_COUNT_API_URL = '/api/get-stream-count';
const cameraCount = ref(0);
const loading = ref(true);
const error = ref(null);

/**
 * 백엔드에서 카메라 개수를 가져오는 비동기 함수
 */
const getCameraCount = async () => {
    loading.value = true; // 로딩 시작
    error.value = null;   // 에러 초기화

    try {
        const res = await fetch(GET_CAMERA_COUNT_API_URL);
        
        if (!res.ok) {
            // HTTP 4xx, 5xx 에러 처리
            const errorData = await res.json();
            throw new Error(errorData.message || `Failed to get: ${res.status} ${res.statusText}`);
        }

        const data = await res.json();
        
        // 1. 성공적으로 데이터를 받으면 cameraCount 업데이트
        const count = Number(data.cameraCount); // 숫자로 변환
        cameraCount.value = count;

        // 2. cameraCount 개수만큼만 cameraList를 초기화
        if (count >= 0 && count <= DEFAULT_CAMERA_LIST.length) {
            // 💡 DEFAULT_CAMERA_LIST의 일부를 cameraList에 할당하여 최종 목록으로 사용
            cameraList.value = DEFAULT_CAMERA_LIST.slice(0, count);
            console.log(`cameraList가 ${count}개로 초기화되었습니다.`, cameraList.value);
        } else {
            console.warn(`유효하지 않은 streamCount 값: ${count}. cameraList를 비웁니다.`);
            cameraList.value = [];
        }
        
    } catch (err) {
        // 네트워크 오류 또는 throw된 오류 처리
        console.error('API call error:', err);
        error.value = err.message;
        cameraCount.value = 0;
        cameraList.value = []; // 오류 시 빈 리스트
    } finally {
        loading.value = false; // 로딩 완료
    }
};

// 카메라 리스트
const cameraList = ref([]);

const EMPTY_CAMERA = { id: 'empty', name: '빈 채널', url: null, viewIndex: null };
const DEFAULT_CAMERA_LIST = [
 { id: 'cam1', name: 'Camera 1', url: '/hls/stream1/stream1.m3u8', viewIndex: 1 },
  { id: 'cam2', name: 'Camera 2', url: '/hls/stream2/stream2.m3u8', viewIndex: 2 },
  { id: 'cam3', name: 'Camera 3', url: '/hls/stream3/stream3.m3u8', viewIndex: 3 },
  { id: 'cam4', name: 'Camera 4', url: '/hls/stream4/stream4.m3u8', viewIndex: 4 },
  { id: 'cam5', name: 'Camera 5', url: '/hls/stream5/stream5.m3u8', viewIndex: null },
  { id: 'cam6', name: 'Camera 6', url: '/hls/stream6/stream6.m3u8', viewIndex: null },
  { id: 'cam7', name: 'Camera 7', url: '/hls/stream7/stream7.m3u8', viewIndex: null },
  { id: 'cam8', name: 'Camera 8', url: '/hls/stream8/stream8.m3u8', viewIndex: null },
  { id: 'cam9', name: 'Camera 9', url: '/hls/stream9/stream9.m3u8', viewIndex: null },
  { id: 'cam10', name: 'Camera 10', url: '/hls/stream10/stream10.m3u8', viewIndex: null },
  { id: 'cam11', name: 'Camera 11', url: '/hls/stream11/stream11.m3u8', viewIndex: null },
  { id: 'cam12', name: 'Camera 12', url: '/hls/stream12/stream12.m3u8', viewIndex: null },
  { id: 'cam13', name: 'Camera 13', url: '/hls/stream13/stream13.m3u8', viewIndex: null },
  { id: 'cam14', name: 'Camera 14', url: '/hls/stream14/stream14.m3u8', viewIndex: null },
  { id: 'cam15', name: 'Camera 15', url: '/hls/stream15/stream15.m3u8', viewIndex: null },
  { id: 'cam16', name: 'Camera 16', url: '/hls/stream16/stream16.m3u8', viewIndex: null },
];


// 💡 뷰에 렌더링할 최종 스트림 데이터 계산된 속성
const activeStreams = computed({
    // Getter: 화면에 표시할 카메라 목록을 필터링하고 정렬하여 반환
    get() {
        // 1. viewIndex가 있는(할당된) 카메라만 필터링하고 정렬 (할당된 카메라 최대 4개)
        const assignedCams = cameraList.value
            .filter(cam => cam.viewIndex !== null)
            .sort((a, b) => a.viewIndex - b.viewIndex);

        // 2. 뷰 영역을 4개로 고정하기 위해 빈 공간을 채웁니다.
        const maxViews = 4;
        const currentCount = assignedCams.length;
        const remainingSlots = maxViews - currentCount;
        
        // 3. 빈 플레이스홀더를 생성하여 추가
        const emptySlots = Array(remainingSlots).fill().map((_, index) => ({
            ...EMPTY_CAMERA,
            // 💡 드래그앤드롭을 위해 고유 ID와 viewIndex를 임시 할당
            id: `empty-${currentCount + index + 1}`, 
            viewIndex: currentCount + index + 1
        }));
        
        // 4. 할당된 카메라와 빈 슬롯을 합쳐서 4개의 배열을 반환
        return [...assignedCams, ...emptySlots];
    },
    
    // Setter: v-model (draggable)을 통해 배열의 순서가 변경되었을 때 호출됨
    set(newStreams) {
        // 1. 💡 가장 먼저, cameraList에 있는 모든 카메라의 viewIndex를 초기화합니다.
        //    (기존에 뷰에 할당되어 있었더라도 드롭 후 뷰 영역 밖으로 밀려났다면 null이 되어야 합니다.)
        cameraList.value.forEach(cam => {
            cam.viewIndex = null;
        });

        // 2. newStreams를 순회하며, 실제 카메라에 대해서만 새로운 viewIndex를 할당합니다.
        newStreams.forEach((newCam, index) => {
          // 빈 채널(플레이스홀더)은 건너뜁니다.
            if (newCam.id.startsWith('empty')) {
                return;
            }

            // 실제 카메라를 cameraList에서 찾아 viewIndex를 업데이트합니다.
            const originalIndex = cameraList.value.findIndex(c => c.id === newCam.id);
            if (originalIndex !== -1) {
                // index는 0부터 시작, viewIndex는 1부터 시작 (현재 뷰 위치)
                cameraList.value[originalIndex].viewIndex = index + 1;
            }
        });

        // 2. viewIndex가 변경되면, Getter가 다시 실행되어 activeStreams가 정확히 갱신됩니다.
        // saveConfig(); 
    }
});


// 채널명 수정 관련
const editingIndex = ref(null);
const editedName = ref('');

// 선택된 카메라
const selectedCameraChipButton = ref(null);

// 하단 메시지 표시 여부
const showMessage = ref(false);
let messageTimeout = null;

// 모바일 여부 체크
const isMobile = ref(false);

// HLS 인스턴스와 비디오 태그 ref
const hlsInstances = [];
const videoElements = reactive([]);

// 모바일 여부 감지
const checkMobile = () => {
  isMobile.value = window.innerWidth <= 768;
};

// HLS 플레이어 초기화
const initPlayers = () => {
    hlsInstances.forEach(hls => hls.destroy());
    hlsInstances.length = 0;

    activeStreams.value.forEach((stream, index) => {
        const video = videoElements[index];
        if (!video) return;

        // 💡 빈 채널(플레이스홀더)이면 스트림 로드를 건너뜁니다.
        if (stream.url === null) {
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

// 칩 선택
const selectCameraChipButton = (cam) => {
  if (selectedCameraChipButton.value && selectedCameraChipButton.value.id === cam.id) {
    // 선택된 칩 다시 클릭 시 선택 취소
    selectedCameraChipButton.value = null;
    showMessage.value = false;
    if (messageTimeout) clearTimeout(messageTimeout);
  } else {
    selectedCameraChipButton.value = cam;
    showMessage.value = true;
    if (messageTimeout) clearTimeout(messageTimeout);
    messageTimeout = setTimeout(() => {
      showMessage.value = false;
    }, 3000);
  }
};

// 선택된 카메라를 영상뷰에 할당
const assignSelectedCameraChipButtonToCameraView = async (index) => {
    if (!selectedCameraChipButton.value) return;

    // 1. 할당 해제: 현재 뷰 영역(index)에 있던 카메라의 viewIndex를 null로 설정
    const currentCamInView = activeStreams.value[index];
    
    // 💡 변경: 현재 뷰 영역에 할당된 카메라가 있고, 그것이 빈 채널이 아니라면 viewIndex를 해제
    if (currentCamInView && !currentCamInView.id.startsWith('empty')) {
        const originalIndex = cameraList.value.findIndex(c => c.id === currentCamInView.id);
        if (originalIndex !== -1) {
            cameraList.value[originalIndex].viewIndex = null;
        }
    }

    // 2. 새 할당: 선택된 카메라(selectedCamera)에 viewIndex를 설정
    // 뷰 영역은 0부터 3까지 있으므로, viewIndex는 1부터 4가 됩니다.
    const selectedIndex = cameraList.value.findIndex(c => c.id === selectedCameraChipButton.value.id);
    if (selectedIndex !== -1) {
        // 💡 viewIndex는 1부터 시작 (index + 1)
        cameraList.value[selectedIndex].viewIndex = index + 1;
    }

    selectedCameraChipButton.value = null;

    await nextTick();
    initPlayers();
    // saveConfig();
};

// 드래그&드롭 종료 후 플레이어 초기화
const onDragEnd = async () => {
  await nextTick();
  initPlayers();
};

// 빈 영역 클릭 시 선택 취소
const onPageClick = () => {
  if (selectedCameraChipButton.value) {
    selectedCameraChipButton.value = null;
    showMessage.value = false;
    if (messageTimeout) clearTimeout(messageTimeout);
  }
};

// ESC 키 눌렀을 때 선택 취소
const onKeyDown = (e) => {
  if (e.key === 'Escape' && selectedCameraChipButton.value) {
    selectedCameraChipButton.value = null;
    showMessage.value = false;
    if (messageTimeout) clearTimeout(messageTimeout);
  }
};

onMounted(async () => {
  await getCameraCount();
  await nextTick();

  initPlayers();
  checkMobile();
  setVH();

  // 모바일일 때 selectedCamera가 없으면 첫 번째 채널 선택 (cameraList를 사용)
  if (isMobile.value && !selectedCameraChipButton.value && cameraList.value.length > 0) {
      selectedCameraChipButton.value = cameraList.value[0];
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', checkMobile);
  window.addEventListener("resize", setVH);
});


onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('resize', checkMobile);
  window.removeEventListener("resize", setVH);
});

function setVH() {
  // 모바일일 때만 적용
  if (isMobile) {
    const vh = (window.innerHeight) * 0.01;
    document.documentElement.style.setProperty("--vh", `${vh}px`);
  }
}

// 채널명 수정 시작
function startEditing(index, currentName) {
  editingIndex.value = index;
  editedName.value = currentName;
}

// 채널명 수정 완료
function finishEditing(index) {
  if (editedName.value.trim() !== '') {
    // 1. 현재 activeStreams에서 변경 대상 카메라 ID를 가져옴
    const targetId = activeStreams.value[index].id;
    
    // 2. cameraList에서 해당 ID를 가진 원본 카메라의 name 필드를 수정
    const originalIndex = cameraList.value.findIndex(c => c.id === targetId);
    if (originalIndex !== -1) {
      // 💡 name 필드를 직접 사용자 지정 이름으로 사용
      cameraList.value[originalIndex].name = editedName.value.trim();
      // saveConfig(); // 백엔드 저장 로직 추가 위치
    }
  }
  editingIndex.value = null;
}
</script>

<style scoped>
/* 전체 페이지 래퍼 */
.page-wrapper {
  width: 100%;
  height: 100dvh;
  margin: 0;
  padding: 0 0 16px 0; /* 아래 칩 버튼 여백 포함 */
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

/* 카메라 칩 리스트 */
.camera-list {
  display: flex;
  margin-top: 10px;
  gap: 8px;
  justify-content: center;
  flex-wrap: wrap;
  user-select: none;
}

/* 각 카메라 칩 스타일 */
.camera-chip {
  background: #eee;
  padding: 6px 10px;
  border-radius: 16px;
  cursor: pointer;
  font-size: 14px;
  transition: background 0.2s, border-color 0.2s;
  border: 2px solid transparent;
}

.camera-chip:hover {
  background: #ccc;
}

.camera-chip.selected {
  border-color: #007bff;
  background: #cce5ff;
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

/* 채널명 수정 input */
.video-name-input {
  font-size: 12px;
  padding: 2px 4px;
  border: none;
  border-radius: 4px;
}

/* 할당 메시지 */
.assign-message {
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0,123,255,0.85);
  color: white;
  padding: 10px 20px;
  border-radius: 20px;
  font-weight: 600;
  box-shadow: 0 0 10px rgba(0,123,255,0.6);
  user-select: none;
  pointer-events: none;
  z-index: 9999;
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

/* 💡 빈 채널 스타일 추가 */
.video-container.empty-channel {
    background: #2c3e50; /* 어두운 색상 */
    display: flex;
    align-items: center;
    justify-content: center;
}

/* 빈 채널일 때 레이블 색상 조정 */
.video-container.empty-channel .video-label {
    background: rgba(0, 0, 0, 0.4);
    color: #ccc;
    cursor: default;
}

/* 모바일에서 1채널만 보여주기 */
@media (max-width: 768px) {
  .video-grid {
    height: calc(var(--vh, 1vh) * 100); /* 100배 곱해줘야 100vh */

    grid-template-columns: 1fr !important;
    grid-template-rows: 1fr !important;
    gap: 0 !important;
  }
}

</style>
