# My Roblox - 실시간 멀티플레이어 완성본

## 포함 기능
- 실제 서버 회원가입/로그인
- 비밀번호 bcrypt 해시 저장
- HTTP-only 로그인 쿠키
- 실제 친구 요청/수락
- 온라인 친구 상태
- Socket.IO 실시간 게임 접속
- 같은 게임방 플레이어 표시
- 실시간 캐릭터 이동 동기화
- 모바일 가상 조이스틱/점프
- 가짜 친구 데이터 제거

## 실행
1. Node.js가 설치된 PC에서 이 폴더를 엽니다.
2. 터미널에서 실행:
   npm install
   npm start
3. 브라우저에서 http://localhost:3000 접속

## 공개 배포 전
환경변수 JWT_SECRET을 충분히 긴 랜덤 문자열로 설정하세요.
SQLite 파일은 data/myroblox.db에 저장됩니다. 여러 서버로 확장할 때는 PostgreSQL과 Redis(Socket.IO adapter)로 전환하는 것을 권장합니다.

## Google Play
이 웹 앱을 Android 앱으로 포장하려면 Capacitor 같은 WebView 기반 패키징 단계가 추가로 필요합니다. Play Store에 올린 앱도 같은 온라인 서버 주소에 연결하면 여러 사용자가 같은 게임방에서 만날 수 있습니다.
