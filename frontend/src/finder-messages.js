// 카메라 주소 찾기 결과(probe) 안내 문구. 카메라 추가/수정 화면이 함께 쓴다.

export function messageFor(r, vendorHint = '') {
  const vendor = vendorHint ? ` (감지된 제조사: ${vendorHint})` : '';
  switch (r.status) {
    case 'unreachable':
      return '카메라에 연결할 수 없습니다. IP 주소가 맞는지, 카메라 전원과 네트워크 연결을 확인하세요.';
    case 'auth_failed': {
      if (r.authUnsupported) {
        return '이 카메라는 지원하지 않는 로그인 방식(Digest SHA-256 등)을 사용합니다. 카메라 설명서의 RTSP 주소를 "RTSP 주소 직접 입력"으로 넣어 주세요.';
      }
      const wait = r.retryAfterSec > 0 ? ` ${lockedNotice(r.retryAfterSec)}` : '';
      return (r.ambiguous
        ? `아이디/비밀번호 또는 경로 문제일 수 있습니다.${vendor} 카메라 자체 웹페이지에서 로그인되는 아이디/비밀번호인지 먼저 확인하고, 안 되면 "주소 직접 입력"을 사용하세요.`
        : '카메라 아이디 또는 비밀번호가 맞지 않습니다. 카메라 자체 웹페이지에서 로그인되는 아이디/비밀번호인지 먼저 확인하세요.') + wait;
    }
    case 'auth_locked':
      return `이 카메라는 최근 로그인 실패가 2회 쌓여 잠시 쉬는 중입니다. ${lockedNotice(r.retryAfterSec || 0)}`;
    case 'rtsp_disabled':
      return `카메라의 RTSP 기능이 꺼져 있는 것 같습니다.${vendor} 카메라 앱이나 자체 웹페이지의 설정(네트워크/스트리밍 등)에서 RTSP를 켠 뒤 다시 시도하세요.`;
    case 'path_not_found':
      return `카메라는 응답했지만 영상 주소를 찾지 못했습니다.${vendor} 카메라 설명서의 RTSP 주소를 확인해 "주소 직접 입력"을 사용하세요.`;
    default:
      return '주소를 찾지 못했습니다.';
  }
}

// 실패가 2회 쌓여 대기에 들어갔을 때의 안내. 다시 시도할 수 있는 시각도 함께 보여 준다
export function lockedNotice(retryAfterSec) {
  const min = Math.max(1, Math.ceil(retryAfterSec / 60));
  const at = new Date(Date.now() + retryAfterSec * 1000).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  return `카메라 자체 잠금을 막기 위해 약 ${min}분 뒤(${at}쯤)부터 다시 시도할 수 있습니다. `
    + '그 사이 카메라 웹페이지에서 아이디/비밀번호를 확인해 두세요. 다른 카메라는 지금 바로 찾을 수 있습니다.';
}

// 화면에는 비밀번호를 가린 주소를 보여 준다
export function maskedUrl(url) {
  return url.replace(/^(rtsp:\/\/[^:@/]*):[^@]*@/, '$1:****@');
}

// 영상 적용만 실패했을 때 (cctv.txt 는 이미 바뀜)
export const APPLY_FAILED = '영상 적용에 실패했습니다. cctvgo.bat을 다시 실행하세요.';
