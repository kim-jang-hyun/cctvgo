<template>
  <h2>실시간 CCTV 스트리밍</h2>
  <div class="multi-viewer">
    <draggable
      v-model="streams"
      item-key="id"
      class="video-grid"
      @end="onDragEnd"
    >
      <template #item="{ element, index }">
        <div class="video-container" :key="element.id">
          <!-- 이름 표시 or 수정 -->
          <div class="video-label" @click="startEditing(index, element.name)">
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
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, nextTick } from 'vue';
import Hls from 'hls.js';
import draggable from 'vuedraggable';

const streams = ref([
  { id: 1, name: 'Camera 1', url: '/hls/stream.m3u8' },
  { id: 2, name: 'Camera 2', url: '/hls/stream.m3u8' },
  { id: 3, name: 'Camera 3', url: '/hls/stream.m3u8' },
  { id: 4, name: 'Camera 4', url: '/hls/stream.m3u8' }
  // { id: 1, name: 'Camera 1', url: 'http://localhost:8085/hls/stream.m3u8' },
  // { id: 2, name: 'Camera 2', url: 'http://localhost:8085/hls/stream.m3u8' },
  // { id: 3, name: 'Camera 3', url: 'http://localhost:8085/hls/stream.m3u8' },
  // { id: 4, name: 'Camera 4', url: 'http://localhost:8085/hls/stream.m3u8' }
]);

const editingIndex = ref(null);
const editedName = ref('');

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

const onDragEnd = async () => {
  await nextTick(); // DOM 재정렬 후 실행
  initPlayers();
};

onMounted(async () => {
  await nextTick();
  initPlayers();
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
.multi-viewer {
  display: flex;
  justify-content: center;
  align-items: center;
}

.video-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
}

.video-container {
  position: relative;
  width: 100%;
  height: 100%;
  aspect-ratio: 16 / 9;
  background: black;
  overflow: hidden;
}

.video-player {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
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

.video-name-input {
  font-size: 12px;
  padding: 2px 4px;
  border: none;
  border-radius: 4px;
}
</style>
