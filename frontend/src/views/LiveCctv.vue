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
          v-if="!isMobile || selectedCamera?.url === element.url"
          class="video-container"
          :class="{ highlight: selectedCamera !== null }"
          @click="assignSelectedCamera(index)"
        >
          <!-- 채널명 표시 및 수정 -->
          <div class="video-label" @click.stop="startEditing(index, element.name)">
            <template v-if="editingIndex === index">
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
        :class="{ selected: selectedCamera && selectedCamera.id === cam.id }"
        @click="selectCamera(cam)"
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

// 카메라 리스트
const cameraList = ref([
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
]);

// 💡 뷰에 렌더링할 최종 스트림 데이터 계산된 속성 (Setter 추가)
const activeStreams = computed({
  // Getter: 화면에 표시할 카메라 목록을 필터링하고 정렬하여 반환 (기존 로직 유지)
  get() {
    // 1. viewIndex가 있는(할당된) 카메라만 필터링
    const assignedCams = cameraList.value.filter(cam => cam.viewIndex !== null);
    
    // 2. viewIndex 순서대로 정렬
    assignedCams.sort((a, b) => a.viewIndex - b.viewIndex);
    
    return assignedCams;
  },
  
  // 💡 Setter: v-model (draggable)을 통해 배열의 순서가 변경되었을 때 호출됨
  set(newStreams) {
    // 1. 새로운 순서(newStreams)를 기반으로 cameraList의 viewIndex를 업데이트
    newStreams.forEach((newCam, index) => {
      const originalIndex = cameraList.value.findIndex(c => c.id === newCam.id);
      if (originalIndex !== -1) {
        // index는 0부터 시작, viewIndex는 1부터 시작
        // 💡 newStreams의 순서(index + 1)를 cameraList의 viewIndex에 반영
        cameraList.value[originalIndex].viewIndex = index + 1;
      }
    });

    // 2. viewIndex가 변경되면, Getter가 다시 실행되어 activeStreams가 정확히 갱신됩니다.

    // saveConfig(); // 💡 드래그 드롭 시 자동 저장 로직을 여기에 추가하는 것이 더 적절합니다.
  }
});


// 채널명 수정 관련
const editingIndex = ref(null);
const editedName = ref('');

// 선택된 카메라
const selectedCamera = ref(null);

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

    if (Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(stream.url);
      hls.attachMedia(video);
      hlsInstances.push(hls);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = stream.url;
    } else {
      alert('HLS를 지원하지 않는 브라우저입니다.');
    }
  });
};

// 칩 선택
const selectCamera = (cam) => {
  if (selectedCamera.value && selectedCamera.value.id === cam.id) {
    // 선택된 칩 다시 클릭 시 선택 취소
    selectedCamera.value = null;
    showMessage.value = false;
    if (messageTimeout) clearTimeout(messageTimeout);
  } else {
    selectedCamera.value = cam;
    showMessage.value = true;
    if (messageTimeout) clearTimeout(messageTimeout);
    messageTimeout = setTimeout(() => {
      showMessage.value = false;
    }, 3000);
  }
};

// 선택된 카메라를 영상뷰에 할당
const assignSelectedCamera = async (index) => {
  if (!selectedCamera.value) return;

  // 1. 할당 해제: 현재 뷰 영역(index)에 있던 카메라의 viewIndex를 null로 설정
  const currentCamInView = activeStreams.value[index];
  if (currentCamInView) {
    const originalIndex = cameraList.value.findIndex(c => c.id === currentCamInView.id);
    if (originalIndex !== -1) {
      cameraList.value[originalIndex].viewIndex = null;
    }
  }

  // 2. 새 할당: 선택된 카메라(selectedCamera)에 viewIndex를 설정하고 name을 업데이트
  const selectedIndex = cameraList.value.findIndex(c => c.id === selectedCamera.value.id);
  if (selectedIndex !== -1) {
    // 💡 viewIndex는 1부터 시작 (index + 1)
    cameraList.value[selectedIndex].viewIndex = index + 1;
  }

  selectedCamera.value = null;

  await nextTick();
  initPlayers();
  // saveConfig(); // 백엔드 저장 로직 추가 위치
};

// 드래그&드롭 종료 후 플레이어 초기화
const onDragEnd = async () => {
  await nextTick();
  initPlayers();
};

// 빈 영역 클릭 시 선택 취소
const onPageClick = () => {
  if (selectedCamera.value) {
    selectedCamera.value = null;
    showMessage.value = false;
    if (messageTimeout) clearTimeout(messageTimeout);
  }
};

// ESC 키 눌렀을 때 선택 취소
const onKeyDown = (e) => {
  if (e.key === 'Escape' && selectedCamera.value) {
    selectedCamera.value = null;
    showMessage.value = false;
    if (messageTimeout) clearTimeout(messageTimeout);
  }
};

onMounted(async () => {
  await nextTick();
  initPlayers();
  checkMobile();
  setVH();

  // 모바일일 때 selectedCamera가 없으면 첫 번째 채널 선택
  if (isMobile.value && !selectedCamera.value) {
    selectedCamera.value = cameraList.value[0];
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
