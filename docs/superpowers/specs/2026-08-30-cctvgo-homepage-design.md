# CCTVGO 홈페이지 디자인 스펙

**날짜:** 2026-08-30  
**도메인:** cctvgo.app  
**호스팅:** Vercel (정적)

## 목적

전 세계 구형 CCTV 사용자를 대상으로 무료 배포 신청을 받는 랜딩페이지.  
신청자에게 수동으로 고객별 패키지를 만들어 Google Drive 링크로 전달한다.

## 구성 (싱글 페이지)

1. **Nav** — 로고, KO/EN 토글, 신청 버튼
2. **Hero** — 핵심 문구 + CTA 버튼 (다크 네이비 배경)
3. **특징** — 4가지 아이콘 카드 (쉬운설치 / 전용주소 / 무료 / 다채널)
4. **작동방식** — 3단계 (신청 → 설치 → 접속)
5. **신청 폼** — 이메일 + 원하는 서브도메인 입력, Formspree 연동
6. **Footer** — 면책조항, 기술지원 없음 고지, FFmpeg 오픈소스 고지

## 다국어

- 브라우저 언어 자동 감지: `ko` → 한국어, 그 외 → 영어
- Nav 우측 KO/EN 버튼으로 수동 전환

## 기술 스택

- 순수 HTML + CSS + Vanilla JS (빌드 단계 없음)
- Formspree 폼 처리 (무료, 월 50건)
- Vercel 배포

## 디자인

- Hero: 다크 네이비 (#0f172a), 흰 텍스트
- 본문: 흰 배경
- 포인트 컬러: 블루 (#3b82f6)
- 폰트: Inter (Google Fonts)
- 모바일 반응형

## 연락처

- 이메일: dagitul@gmail.com
- 카카오채널: (링크 추후 입력)

## 주요 카피 (한/영)

**Hero 헤드라인**
- KO: 어디서든 내 CCTV를 보세요
- EN: Watch Your CCTV From Anywhere

**Hero 서브**
- KO: 클라우드 없이 설치 한 번으로 스마트폰, PC에서 확인
- EN: Simple installation. No cloud. Access from any device.

## 면책 문구

- KO: 본 제품은 설치형 소프트웨어로, 기술지원은 제공되지 않습니다. 가정용 또는 개인용 용도로 권장됩니다.
- EN: This is a self-installed software. No technical support is provided. Recommended for personal or home use only.
