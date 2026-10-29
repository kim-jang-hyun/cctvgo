import router from './router';

/**
 * 로그인 세션을 쓰는 JSON API 호출.
 * 세션이 만료돼 authMiddleware 가 /login 으로 리다이렉트하면 로그인 화면으로 보낸다.
 * 실패 응답은 서버가 준 message 로 Error 를 던진다 (err.status 에 HTTP 상태).
 */
export async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let finalPath = '';
  try { finalPath = new URL(res.url).pathname; } catch (e) { /* url 없음 */ }
  if (res.redirected || finalPath === '/login') {
    router.push('/login');
    throw new Error('로그인이 필요합니다.');
  }
  const type = res.headers.get('content-type') || '';
  let data;
  try {
    if (!type.includes('application/json')) throw new Error('not json');
    data = await res.json();
  } catch (e) {
    throw new Error(`서버 응답을 처리할 수 없습니다. (${res.status})`);
  }
  if (!res.ok) throw Object.assign(new Error(data.message || `요청에 실패했습니다. (${res.status})`), { status: res.status });
  return data;
}
