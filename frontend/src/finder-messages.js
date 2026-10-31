// 카메라 주소 찾기 결과(probe) 안내 문구. 카메라 추가/수정 화면이 함께 쓴다.
// context: 'scan'(자동으로 주소 찾기) | 'manual'(주소를 직접 넣어 시험) | 'edit'(카메라 수정)

// 경로가 틀려도 로그인 실패(401)로 답하는 카메라는 비밀번호 오류와 구별할 수 없다. 비밀번호를 거듭 넣다 카메라가 잠기지 않도록
// 먼저 카메라 웹페이지에서 확인하게 하고, 로그인된다면 다시 시도하지 말고 주소를 직접 넣게 한다
function ambiguousAuthMessage(context) {
  if (context === 'manual') {
    return '아이디/비밀번호 또는 입력한 주소가 맞지 않습니다. 카메라 웹페이지에 이 아이디/비밀번호로 로그인되는지 확인하고, 카메라 설명서의 RTSP 주소와 같은지 확인하세요.';
  }
  const next = context === 'edit'
    ? '다시 시도하지 말고, 이 카메라를 삭제한 뒤 [카메라 추가 → RTSP 주소로 추가]에 카메라 설명서의 RTSP 주소를 넣어 주세요.'
    : '다시 시도하지 말고 [주소 직접 입력]에 카메라 설명서의 RTSP 주소를 넣어 주세요.';
  const retry = context === 'edit' ? '[다시 입력]' : '[아이디/비밀번호 다시 입력]';
  return [
    '비밀번호가 틀렸거나, 이 카메라는 영상 주소를 자동으로 찾기 어려운 카메라입니다.',
    '1. 카메라 웹페이지에 이 아이디/비밀번호로 로그인되는지 확인하세요.',
    `2. 로그인된다면 비밀번호는 맞습니다. ${next}`,
    `3. 로그인되지 않는다면 ${retry}을 누르세요.`,
  ].join('\n');
}

/** 자동 찾기에서 "비밀번호 또는 경로" 를 구별할 수 없는 실패인지 (화면이 [주소 직접 입력]을 앞에 강조한다) */
export function isAmbiguousAuth(r) {
  return !!r && r.status === 'auth_failed' && r.ambiguous && !r.authUnsupported;
}

export function messageFor(r, vendorHint = '', context = 'scan') {
  const vendor = vendorHint ? ` (감지된 제조사: ${vendorHint})` : '';
  switch (r.status) {
    case 'unreachable':
      return '카메라에 연결할 수 없습니다. IP 주소가 맞는지, 카메라 전원과 네트워크 연결을 확인하세요.';
    case 'auth_failed': {
      if (r.authUnsupported) {
        return '이 카메라는 지원하지 않는 로그인 방식(Digest SHA-256 등)을 사용합니다. 카메라 설명서의 RTSP 주소를 "RTSP 주소 직접 입력"으로 넣어 주세요.';
      }
      if (r.ambiguous) return `${ambiguousAuthMessage(context)}\n${LOGIN_WARNING}`;
      return `카메라 아이디 또는 비밀번호가 맞지 않습니다. 카메라 웹페이지에 이 아이디/비밀번호로 로그인되는지 먼저 확인하세요.\n${LOGIN_WARNING}`;
    }
    case 'auth_locked':
      return `카메라 로그인에 실패했습니다. ${LOGIN_WARNING}`;
    case 'rtsp_disabled':
      return `카메라의 RTSP 기능이 꺼져 있는 것 같습니다.${vendor} 카메라 앱이나 자체 웹페이지의 설정(네트워크/스트리밍 등)에서 RTSP를 켠 뒤 다시 시도하세요.`;
    case 'path_not_found':
      return `카메라는 응답했지만 영상 주소를 찾지 못했습니다.${vendor} 카메라 설명서의 RTSP 주소를 확인해 "주소 직접 입력"을 사용하세요.`;
    default:
      return '주소를 찾지 못했습니다.';
  }
}

// 로그인 실패 안내. CCTVGO 는 다시 시도를 막지 않으므로(2026-10-31 결정) 카메라가 잠길 수 있다는 것을 분명히 알린다
export const LOGIN_WARNING = '카메라 비밀번호를 여러 번 틀리면 카메라가 일정 시간 접속을 막을 수 있습니다. 그동안 CCTVGO에서 이 카메라 영상이 나오지 않고, 카메라에 따라 녹화기나 휴대폰 앱의 접속도 함께 막힐 수 있습니다. 다시 시도하기 전에 카메라 웹페이지에 이 아이디/비밀번호로 로그인되는지 꼭 확인하세요.';

// 화면에는 비밀번호를 가린 주소를 보여 준다
export function maskedUrl(url) {
  return url.replace(/^(rtsp:\/\/[^:@/]*):[^@]*@/, '$1:****@');
}

// 영상 적용만 실패했을 때 (cctv.txt 는 이미 바뀜)
export const APPLY_FAILED = '영상 적용에 실패했습니다. cctvgo.bat을 다시 실행하세요.';
