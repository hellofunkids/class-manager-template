# 수업 관리 앱

선생님은 출석을 누르고, 미리 채워진 진도를 확인하고, 숙제만 체크하면
학부모님께 일간·주간·월간 리포트 문자(알림톡)가 자동으로 가는 학원용 웹앱이에요.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hellofunkids/class-manager-template)

## 버튼으로 내 앱 만들기 (10~15분)

**먼저 준비할 것**: GitHub 계정, Cloudflare 계정, 해외결제 신용카드, 솔라피 API Key·Secret·발신번호

1. **R2 켜기 (처음 한 번)**: Cloudflare → Storage & databases → R2 Object Storage → Purchase R2 Plan → 카드 등록. 무료 10GB 안에서는 0원이에요.
2. 위의 **Deploy to Cloudflare** 버튼을 눌러요.
3. GitHub 연결 → 저장소 이름과 앱 이름은 그대로 두거나 바꿔요 (`class-manager`).
4. 솔라피 칸 3개를 채워요: `SOLAPI_KEY`, `SOLAPI_SECRET`, `SOLAPI_FROM`(발신번호, 숫자만).
5. **Create and deploy**를 눌러요. 데이터베이스와 사진·영상 저장소는 자동으로 만들어져요.
6. 끝나면 나오는 주소로 들어가 **학원 이름**과 **원장 비밀번호**를 정해요.
7. 관리 탭에서 선생님 → 진도표 → 반 → 학생 순서로 넣고, **테스트 문자 보내기**로 확인해요.

내 GitHub에 복사본이 생기니까, 나중에 Claude에게 그 저장소를 연결해 기능을 더하거나 고칠 수 있어요. GitHub에 저장하면 자동으로 다시 배포돼요.

## 자주 묻는 것
- **배포가 R2 오류로 실패해요**: 1번(R2 켜기)을 먼저 하고 Deployments에서 Retry build를 눌러요.
- **주소가 안 열려요**: 앱 → Settings → Domains & Routes → workers.dev를 Enable 해요.
- **문자가 안 가요**: 솔라피 발신번호 등록·충전, Key와 Secret이 짝이 맞는지 확인해요.
- **비용**: Cloudflare 무료 플랜으로 충분해요. 문자는 솔라피 건당 요금만 나가요.
