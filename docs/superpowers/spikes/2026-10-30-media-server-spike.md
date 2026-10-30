# 미디어 서버 시험 기록 (2026-10-30)
환경: PC 192.168.219.131 (Wi-Fi, 네트워크 프로필 Public), 공유기 192.168.219.1, 공인 IP 14.4.x.x(집 공인 IP), Chrome 156 / Edge 156, Intel Iris Xe
카메라: cam=192.168.219.100 Hikvision계열 H.264 1080p25 / cam2=192.168.219.103 /onvif1 H.265 2560x1440 20fps + G711, /onvif2 H.265 640x368
## MediaMTX v1.21.3
- LAN: PC Chrome, 휴대폰 재생 OK, 체감 지연 없음
- CPU ~0.04%(12코어 전체 기준), 메모리 52MB (cam 1개)
- 실행 중 경로 추가/삭제(API) 시 다른 카메라 유지
- H.265: iPhone 재생 OK (메인/서브), PC Chrome "codecs not supported by client"
- LTE(LG U+ 알뜰폰, 211.36.x.x(LTE)), UPnP 없이: cam, cam2 모두 OK. srflx 14.4.x.x(집 공인 IP) <-> srflx 211.36.x.x(LTE) 직접
- UPnP SSDP 탐색: 응답 없음 (Public 프로필 방화벽이 막았을 가능성, 미확인)
- 재연결 시험: 미실시
## go2rtc v1.9.15
- LAN: PC Chrome, 휴대폰 재생 OK, 체감 지연 MediaMTX와 동일(실시간)
- CPU ~0.18%, 메모리 55MB (카메라 2개 시청 중), 기본이 시청자 있을 때만 카메라 접속
- LTE(LG U+ 알뜰폰), UPnP 없이: cam, cam2 OK. iPhone srflx 211.36.x.x(LTE) 직접(ws 시그널링 + udp 영상)
- 재연결 시험: 미실시
- go2rtc 재연결: 카메라 전원 차단 18:02:43 감지(i/o timeout) → 재부팅 후 카메라 자동 재접속, 같은 WebRTC 세션으로 계속 전송(5초에 ~190KB). 브라우저 video 는 멈춤(일시정지) 상태라 재생 버튼을 눌러야 다시 나옴 → 우리 화면에서 자동 재생 처리 필요
- MediaMTX 재연결: 전원 차단 18:09:43 감지 → 브라우저 세션 즉시 종료 → 시험 화면이 2초마다 재시도("no stream is available") → 카메라 복귀 18:10:33 → 2초 뒤 18:10:35 자동 재생(버튼 불필요)
## PC Chrome H.265 대안 (go2rtc 변환)
- 번들 FFmpeg(N-119886)에 libx264 없음. h264_qsv / h264_mf / amf / nvenc 만 있음. 직접 시험: qsv 1.6x, mf 1.55x (실시간 이상)
- go2rtc 기본 h264 템플릿은 libx264 → 실패. ffmpeg.h264 를 "-c:v h264_qsv -g 20 -bf 0 -look_ahead 0" 으로 바꿔야 함
- 원본+변환을 한 이름(cam2: [rtsp, ffmpeg:cam2#video=h264])으로 묶으면 원본에서 소리만 잡고 변환을 시작하지 않아 검은 화면 → 변환 전용 이름(cam2h) 필요, 브라우저 지원 여부로 화면이 고르게
- 변환에는 go2rtc 내부 RTSP(127.0.0.1:8554) 필요
- go2rtc 는 API PUT 으로 추가한 스트림을 설정 파일에 써 넣음(주의)
- cam2h(2560x1440 H.265→H.264, qsv): PC Chrome 재생 OK. cctvgo-ffmpeg CPU 6.9%(i5-1334U 12스레드 전체 기준) 메모리 297MB, go2rtc 0.8%/36MB
## Windows 내장 H.264 변환기 (h264_mf, hw_encoding 0) — GPL 아님, 번들 FFmpeg 그대로 사용 가능
- go2rtc 의 #video=<임의이름> 프리셋은 동작 안 함(제작자 미연결) → exec:ffmpeg ... -f rtsp {output} 로 지정해야 함
- 2560x1440 H.265→H.264 4Mbps: 화질 qsv 와 거의 같음, 지연 qsv 대비 1~2초 더 늦음, CPU 6.2%, 메모리 ~800MB(일정)
- ld_vbr + scenario video_conference 로 바꿔도 지연 체감 차이 없음, CPU 5.8%, 메모리 820MB
- hw_encoding 1 은 이 FFmpeg 에서 실패(-22)
