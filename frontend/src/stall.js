// 재생 중 영상 멈춤 판단
// 카메라 전원이 꺼지면 브라우저와 go2rtc 사이 연결은 살아 있고 데이터만 끊긴다 (2026-11-03 실기 확인).
// 그래서 연결 상태 대신 받은 영상 바이트가 늘고 있는지를 본다. 정상 카메라는 장면이 멈춰 있어도 초당 여러 프레임을 보낸다.

export const STALL_MS = 10 * 1000;
export const STALL_CHECK_MS = 2 * 1000;

/** update(bytes, now): 받은 바이트 누계를 넣으면 멈췄는지(true) 돌려준다. bytes 가 null 이면(통계 못 읽음) 판단하지 않는다 */
export function createStallTracker(now, stallMs = STALL_MS) {
  let lastBytes = null;
  let lastChange = now;
  return {
    update(bytes, t) {
      if (bytes == null) return false;
      if (lastBytes === null || bytes !== lastBytes) {
        lastBytes = bytes;
        lastChange = t;
        return false;
      }
      return t - lastChange >= stallMs;
    },
  };
}

/** 받은 영상 바이트 누계 (못 읽으면 null) */
export async function videoBytesReceived(pc) {
  try {
    const stats = await pc.getStats();
    let total = null;
    stats.forEach(s => {
      if (s.type === 'inbound-rtp' && (s.kind || s.mediaType) === 'video') total = (total || 0) + (s.bytesReceived || 0);
    });
    return total;
  } catch (e) {
    return null;
  }
}
