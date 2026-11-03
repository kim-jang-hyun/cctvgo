// 카메라가 오래 응답하지 않는 칸 판단
// - "카메라가 응답하지 않습니다"(reason: camera)는 CCTVGO PC 가 카메라에서 영상을 받지 못했다는 뜻이다 (보는 쪽 인터넷 문제와 구분됨)
// - 그 상태가 처음 나온 시각을 기억하고, 다시 시도하는 동안('connecting')에도 유지한다
// - 한 번이라도 재생되거나 다른 이유로 실패하면(카메라 상태를 알 수 없음) 지운다
// - 카메라 재부팅·잠깐의 끊김은 보통 1분 안에 돌아오므로, 2분이 넘어야 IP 변경 안내를 보여 준다

export const CAMERA_DOWN_LONG_MS = 2 * 60 * 1000;

/** 상태 변화 하나를 반영한 새 "응답 없음 시작 시각"을 돌려준다 (null 이면 기록 없음) */
export function nextDownSince(prevSince, state, reason, now) {
  if (state === 'failed') return reason === 'camera' ? (prevSince ?? now) : null;
  if (state === 'playing') return null;
  return prevSince ?? null;   // connecting: 다시 시도하는 중에는 그대로 둔다
}

export function isLongDown(since, now, limitMs = CAMERA_DOWN_LONG_MS) {
  return since != null && now - since >= limitMs;
}
