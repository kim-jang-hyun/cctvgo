// 카메라 영상 WebRTC 연결.
// 연결 정보(SDP)만 서버(/api/live/:k/offer, 로그인 필요)를 거치고, 영상은 고객 PC 의 go2rtc 에서 브라우저로 직접 온다.
// go2rtc POST 방식은 후보를 나중에 보내는 방식(trickle)이 없어서, 후보 수집을 끝낸 offer 를 보낸다.
import router from './router';

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

/** 로그인 세션이 끝나 서버가 /login 으로 돌려보냈는지 (api.js 와 같은 판단) */
function wentToLogin(res) {
  let finalPath = '';
  try { finalPath = new URL(res.url).pathname; } catch (e) { /* url 없음 */ }
  return res.redirected || finalPath === '/login';
}

/**
 * video 요소에 카메라 k 의 영상을 연결한다. 끊기거나 실패하면 스스로 다시 연결한다(코덱 미지원은 다시 하지 않음).
 * epoch: 채널 목록에서 받은 번호 체계. 서비스가 다시 시작해 바뀌었으면 onStale() 을 부르고 멈춘다(화면이 목록을 다시 받는다).
 * onState(state, detail): 'connecting' | 'playing' | 'failed' (detail.reason: network | codec | camera | signaling | disconnected)
 * 반환값: 연결을 끊고 정리하는 함수
 */
export function connectStream(video, k, { epoch = '', onState = () => {}, onStale = () => {} } = {}) {
  let closed = false;
  let pc = null;
  let timer = null;
  let attempt = 0;
  let detachAttempt = () => {};   // 지금 시도의 playing 리스너 정리 (시도마다 하나만 남게)

  const resume = () => { if (!closed && video.paused) video.play().catch(() => {}); };
  // 카메라가 재부팅된 뒤 영상이 다시 들어와도 video 가 일시정지로 남는 경우가 있어 다시 재생한다
  video.addEventListener('pause', resume);
  video.addEventListener('stalled', resume);

  const cleanupPc = () => {
    detachAttempt();
    detachAttempt = () => {};
    if (pc) { try { pc.close(); } catch (e) { /* 이미 닫힘 */ } pc = null; }
    clearTimeout(timer);
  };

  const stop = () => {
    closed = true;
    cleanupPc();
  };

  const retryLater = () => {
    if (closed) return;
    const wait = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
    attempt++;
    timer = setTimeout(start, wait);
  };

  async function start() {
    if (closed) return;
    cleanupPc();
    onState('connecting');
    const startedAt = Date.now();
    const h265 = canReceiveH265();
    const myPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc = myPc;
    const current = () => pc === myPc && !closed;
    let settled = false;   // 이 시도의 실패 처리는 한 번만 (끊김과 실패, 시간 초과가 겹쳐도 재시도가 두 번 걸리지 않게)
    let variant = null;
    let playing = false;

    const fail = (reason, extra = {}) => {
      if (settled || !current()) return;
      settled = true;
      onState('failed', { reason });
      cleanupPc();
      if (reason !== 'codec') retryLater();
      // 통계는 정리 전에 모아 둔 값을 쓴다
      report({ k, outcome: 'failed', reason, variant, h265, ms: Date.now() - startedAt, ...extra });
    };

    myPc.addTransceiver('video', { direction: 'recvonly' });
    myPc.addTransceiver('audio', { direction: 'recvonly' });
    myPc.ontrack = e => {
      if (!current()) return;
      if (!video.srcObject) video.srcObject = new MediaStream();
      video.srcObject.addTrack(e.track);
      e.track.onunmute = resume;
      resume();
    };

    const onPlaying = async () => {
      if (playing || !current()) return;
      playing = true;
      clearTimeout(timer);
      attempt = 0;
      onState('playing');
      report({ k, outcome: 'playing', variant, h265, ms: Date.now() - startedAt, ...(await candidateSummary(myPc)) });
    };
    video.addEventListener('playing', onPlaying);
    detachAttempt = () => video.removeEventListener('playing', onPlaying);

    myPc.onconnectionstatechange = async () => {
      if (!current() || settled) return;
      const s = myPc.connectionState;
      if (s === 'failed' || (s === 'disconnected' && playing)) {
        const summary = await candidateSummary(myPc);
        fail(playing ? 'disconnected' : 'network', summary);
      }
    };

    try {
      if (video.srcObject) video.srcObject = null;
      await myPc.setLocalDescription(await myPc.createOffer());
      await waitIceGathering(myPc);
      if (!current()) return;
      const res = await fetch(`/api/live/${k}/offer?epoch=${encodeURIComponent(epoch)}&h265=${h265 ? 1 : 0}`, {
        method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: myPc.localDescription.sdp,
      });
      if (!current()) return;
      // 오래 켜 둔 화면에서 로그인 세션이 끝났으면 로그인 화면으로 보낸다 (계속 재시도하지 않는다)
      if (wentToLogin(res)) {
        stop();
        router.push('/login');
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!current()) return;
      // 서비스가 다시 시작해 카메라 번호가 바뀌었거나 이 번호의 카메라가 없어졌으면 화면이 목록을 다시 받는다
      if (data.reason === 'stale' || data.reason === 'not_found') {
        stop();
        onStale();
        return;
      }
      if (data.status !== 'success') {
        const reason = data.reason === 'codec' ? 'codec' : data.reason === 'unavailable' ? 'camera' : 'signaling';
        return fail(reason, { status: res.status });
      }
      variant = data.variant;
      await myPc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
      timer = setTimeout(async () => {
        if (!current() || playing || settled) return;
        const summary = await candidateSummary(myPc);
        fail('network', summary);
      }, CONNECT_TIMEOUT_MS);
    } catch (e) {
      fail('signaling', { error: String((e && e.message) || e).slice(0, 100) });
    }
  }

  start();

  return () => {
    stop();
    video.removeEventListener('pause', resume);
    video.removeEventListener('stalled', resume);
    video.srcObject = null;
  };
}
