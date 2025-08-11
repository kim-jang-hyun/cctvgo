<template>
  <div class="page-wrapper">
    <h2>실시간 CCTV 스트리밍</h2>

    <!-- 채널 뷰어 (드래그앤드랍 가능) -->
    <draggable
      v-model="streams"
      item-key="id"
      class="video-grid"
      :group="{ name: 'channels', pull: true, put: true }"
      @end="onDragEnd"
      @click.stop
    >
      <template #item="{ element, index }">
        <div
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
      위 영상에 할당해 주세요.
    </div>
  </transition>
</template>

<script setup>
import { ref, reactive, onMounted, nextTick, onBeforeUnmount } from 'vue';
import Hls from 'hls.js';
import draggable from 'vuedraggable';

const cameraList = ref([
  { id: 'cam1', name: 'Camera 1', url: '/hls/stream1.m3u8' },
  { id: 'cam2', name: 'Camera 2', url: '/hls/stream2.m3u8' },
  { id: 'cam3', name: 'Camera 3', url: '/hls/stream3.m3u8' },
  { id: 'cam4', name: 'Camera 4', url: '/hls/stream4.m3u8' },
  { id: 'cam5', name: 'Camera 5', url: '/hls/stream5.m3u8' }
]);

const streams = ref([
  { id: 1, name: 'Camera 1', url: '/hls/stream1.m3u8' },
  { id: 2, name: 'Camera 2', url: '/hls/stream2.m3u8' },
  { id: 3, name: 'Camera 3', url: '/hls/stream3.m3u8' },
  { id: 4, name: 'Camera 4', url: '/hls/stream4.m3u8' }
]);

const editingIndex = ref(null);
const editedName = ref('');
const selectedCamera = ref(null);
const showMessage = ref(false);
let messageTimeout = null;

const hlsInstances = [];
const videoElements = reactive([]);

const initPlayers = () => {
  hlsInstances.forEach(hls => hls.destroy());
  hlsInstances.length = 0;

  streams.value.forEach((stream, index) => {
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

const assignSelectedCamera = async (index) => {
  if (!selectedCamera.value) {
    // 선택된 채널 없으면 아무 동작 안 함
    return;
  }
  streams.value[index] = {
    ...streams.value[index],
    name: selectedCamera.value.name,
    url: selectedCamera.value.url
  };
  selectedCamera.value = null;

  await nextTick();
  initPlayers();
};

const onDragEnd = async () => {
  await nextTick();
  initPlayers();
};

const onPageClick = () => {
  // 빈 영역 클릭 시 선택된 칩 해제
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
  window.addEventListener('keydown', onKeyDown);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown);
});

function startEditing(index, currentName) {
  editingIndex.value = index;
  editedName.value = currentName;
}

function finishEditing(index) {
  if (editedName.value.trim() !== '') {
    streams.value[index].name = editedName.value.trim();
  }
  editingIndex.value = null;
}
</script>

<style scoped>
/* html, body 기본 설정 */
html, body {
  height: 100%;
  margin: 0;
  padding: 0;
  overflow: hidden; /* 스크롤바 숨김 */
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
}

/* 전체 페이지 래퍼 */
.page-wrapper {
  width: 100%;
  height: 100vh; /* 뷰포트 전체 높이 */
  margin: 0;
  padding: 10px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  overflow: hidden; /* 내부 스크롤 방지 */
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
  border: 4px solid #007bff;
  box-shadow: 0 0 8px rgba(0, 123, 255, 0.7);
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

</style>
