# make_package.bat 에서 부른다. 고객마다 다른 로그인 비밀번호를 만들어
# package\config.json 에 넣고, package\사용 방법.txt 를 만든 뒤, 비밀번호 한 줄만 출력한다.
# (개발용 backend\config.json 은 건드리지 않는다)
param(
    [Parameter(Mandatory = $true)][string]$PackageDir,
    [Parameter(Mandatory = $true)][string]$CustomerId
)
$ErrorActionPreference = 'Stop'

# 헷갈리는 글자(0 o 1 l i)는 뺀다. 휴대폰에서 치기 쉽게 소문자와 숫자만 쓴다
$chars = 'abcdefghjkmnpqrstuvwxyz23456789'
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$buf = New-Object byte[] 1
$sb = New-Object System.Text.StringBuilder
# 고르게 뽑으려고 글자 수의 배수 범위를 넘는 값은 버린다
$limit = 256 - (256 % $chars.Length)
while ($sb.Length -lt 8) {
    $rng.GetBytes($buf)
    if ($buf[0] -lt $limit) { [void]$sb.Append($chars[$buf[0] % $chars.Length]) }
}
$password = $sb.ToString()

$configPath = Join-Path $PackageDir 'config.json'
$config = Get-Content -Raw -Encoding UTF8 $configPath | ConvertFrom-Json
$config.password = $password
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json) + "`n", $utf8)

$info = @"
CCTVGO 사용 방법

[1] 실행하기
- 이 폴더의 cctvgo.bat 을 더블클릭합니다.
- 까만 창이 뜨고 "CCTVGO 시스템 작동 중"이 보이면 준비 완료입니다.
- 이 창을 닫으면 CCTVGO가 꺼집니다. 창은 닫지 말고 작게 내려 두세요.

[2] 카메라 추가하기
1. 아래 접속 주소로 들어가 비밀번호로 로그인합니다.
2. 오른쪽 위 톱니바퀴(설정) > 카메라 관리 > + 카메라 추가
3. 찾은 카메라 옆의 [추가]를 누르고, 카메라 아이디/비밀번호를 넣은 뒤 [주소 찾기]
4. 카메라 이름을 넣고 [추가]를 누르면 끝입니다.
- 목록에 카메라가 없으면 같은 화면에서 IP 주소나 RTSP 주소로 직접 추가할 수 있습니다.

[3] 접속 정보
접속 주소: https://$CustomerId.cctvgo.app
비밀번호: $password

- 같은 공유기 안에서는 http://(이 PC의 IP):8085 로도 접속할 수 있습니다.
- 비밀번호는 접속한 뒤 설정 > 비밀번호 변경에서 바꿀 수 있습니다. (8자 이상)
- 비밀번호를 5번 연속 틀리면 그 기기에서는 15분 동안 로그인할 수 없습니다.
- 비밀번호를 잊으면 이 폴더의 config.json 에서 "password" 값을 확인하거나 고칠 수 있습니다.
"@
[System.IO.File]::WriteAllText((Join-Path $PackageDir '사용 방법.txt'), ($info -replace "`r?`n", "`r`n"), (New-Object System.Text.UTF8Encoding $true))

Write-Output $password
