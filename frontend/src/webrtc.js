// 카메라 영상 WebRTC 연결.
// 연결 정보(SDP)만 서버(/api/live/:k/offer, 로그인 필요)를 거치고, 영상은 고객 PC 의 go2rtc 에서 브라우저로 직접 온다.
// go2rtc POST 방식은 후보를 나중에 보내는 방식(trickle)이 없어서, 후보 수집을 끝낸 offer 를 보낸다.

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const GATHER_TIMEOUT_MS = 2000;
const CONNECT_TIMEOUT_MS = 15000;
const RETRY_DELAYS_MS = [5000, 10000, 20000, 40000, 60000];

/** 이 브라우저가 WebRTC 로 H.265 를 받을 수 있는지 (아이폰 사파리 엔진은 가능, PC 크롬은 대부분 불가) */
export function canReceiveH265() {
  try {
    const caps = RTCRtpReceiver.getCapabilities && RTCRtpReceiver.getCapabilities('video');
    return !!caps && caps.codecs.some(c => /h265|hevc/i.test(c.mimeType));
  } catch (e) {
    return false;
  }
}

function waitIceGathering(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { pc.removeEventListener('icegatheringstatechange', check); clearTimeout(timer); resolve(); };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    const timer = setTimeout(done, GATHER_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

/** 실패 원인 분석용: 이 브라우저가 모은 후보 종류와, 연결됐다면 실제로 쓰인 후보쌍 종류 */
async function candidateSummary(pc) {
  const out = { local: [], pair: null };
  try {
    const stats = await pc.getStats();
    const byId = new Map();
    stats.forEach(s => byId.set(s.id, s));
    const types = new Set();
    stats.forEach(s => {
      if (s.type === 'local-candidate') types.add(`${s.candidateType}/${s.protocol}`);
      if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') {
        const l = byId.get(s.localCandidateId);
        const r = byId.get(s.remoteCandidateId);
        out.pair = { local: l && l.candidateType, remote: r && r.candidateType, protocol: l && l.protocol };
      }
    });
    out.local = [...types];
  } catch (e) { /* 통계를 못 얻어도 기록은 보낸다 */ }
  return out;
}

function report(data) {
  try {
    const body = JSON.stringify(data);
    if (!(navigator.sendBeacon && navigator.sendBeacon('/api/live/report', new Blob([body], { type: 'application/json' })))) {
      fetch('/api/live/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    }
  } catch (e) { /* 기록 실패는 무시 */ }
}

/**
 * video 요소에 카메라 k 의 영상을 연결한다. 끊기거나 실패하면 스스로 다시 연결한다(코덱 미지원은 다시 하지 않음).
 * onState(state, detail): 'connecting' | 'playing' | 'failed' (detail.reason: network | codec | camera | signaling)
 * 반환값: 연결을 끊고 정리하는 함수
 */
export function connectStream(video, k, { onState = () => {} } = {}) {
  let closed = false;
  let pc = null;
  let timer = null;
  let attempt = 0;

  const resume = () => { if (!closed && video.paused) video.play().catch(() => {}); };
  // 카메라가 재부팅된 뒤 영상이 다시 들어와도 video 가 일시정지로 남는 경우가 있어 다시 재생한다
  video.addEventListener('pause', resume);
  video.addEventListener('stalled', resume);

  const cleanupPc = () => {
    if (pc) { try { pc.close(); } catch (e) { /* 이미 닫힘 */ } pc = null; }
    clearTimeout(timer);
  };

  const retryLater = () => {
    if (closed) return;
    const wait = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
    attempt++;
    timer = setTimeout(start, wait);
  };

  const fail = (reason, extra = {}) => {
    onState('failed', { reason });
    report({ k, outcome: 'failed', reason, ...extra });
    cleanupPc();
    if (reason !== 'codec') retryLater();
  };

  async function start() {
    if (closed) return;
    cleanupPc();
    onState('connecting');
    const startedAt = Date.now();
    const h265 = canReceiveH265();
    const myPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc = myPc;
    myPc.addTransceiver('video', { direction: 'recvonly' });
    myPc.addTransceiver('audio', { direction: 'recvonly' });
    myPc.ontrack = e => {
      if (!video.srcObject) video.srcObject = new MediaStream();
      video.srcObject.addTrack(e.track);
      e.track.onunmute = resume;
      resume();
    };

    let variant = null;
    let playing = false;
    const onPlaying = async () => {
      if (playing || pc !== myPc) return;
      playing = true;
      clearTimeout(timer);
      attempt = 0;
      onState('playing');
      report({ k, outcome: 'playing', variant, h265, ms: Date.now() - startedAt, ...(await candidateSummary(myPc)) });
    };
    video.addEventListener('playing', onPlaying, { once: true });

    myPc.onconnectionstatechange = async () => {
      if (pc !== myPc) return;
      const s = myPc.connectionState;
      if (s === 'failed' || (s === 'disconnected' && playing)) {
        video.removeEventListener('playing', onPlaying);
        fail(playing ? 'disconnected' : 'network', { variant, h265, ms: Date.now() - startedAt, ...(await candidateSummary(myPc)) });
      }
    };

    try {
      if (video.srcObject) video.srcObject = null;
      await myPc.setLocalDescription(await myPc.createOffer());
      await waitIceGathering(myPc);
      if (pc !== myPc) return;
      const res = await fetch(`/api/live/${k}/offer?h265=${h265 ? 1 : 0}`, {
        method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: myPc.localDescription.sdp,
      });
      const data = await res.json().catch(() => ({}));
      if (pc !== myPc) return;
      if (data.status !== 'success') {
        const reason = data.reason === 'codec' ? 'codec' : data.reason === 'unavailable' || data.reason === 'not_found' ? 'camera' : 'signaling';
        return fail(reason, { h265, status: res.status });
      }
      variant = data.variant;
      await myPc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
      timer = setTimeout(async () => {
        if (pc !== myPc || playing) return;
        video.removeEventListener('playing', onPlaying);
        fail('network', { variant, h265, ms: Date.now() - startedAt, ...(await candidateSummary(myPc)) });
      }, CONNECT_TIMEOUT_MS);
    } catch (e) {
      if (pc === myPc) fail('signaling', { h265, error: String(e && e.message || e).slice(0, 100) });
    }
  }

  start();

  return () => {
    closed = true;
    video.removeEventListener('pause', resume);
    video.removeEventListener('stalled', resume);
    cleanupPc();
    video.srcObject = null;
  };
}
