# Tarball Atlas

npm 패키지의 다운로드 크기가 늘었을 때, 어느 파일이 추가되거나 커졌는지 두 릴리스를 비교해 보여줍니다. 브라우저에서 예제를 열면 `moment-timezone`의 다운로드 크기가 한 패치 만에 217,410바이트에서 639,171바이트로 늘어난 내역을 볼 수 있습니다. 새로 들어간 `tzdata-latest.tar.gz` 하나가 압축 해제 후 증가량의 약 99%를 차지합니다. [웹에서 예제 열기](https://hakm12-ship-it.github.io/tarball-atlas/) · [English](README.md)

## 브라우저에서 비교하기

1. **npm registry**에서 **Baseline**에 이전 버전, **Candidate**에 새 버전을 입력하고 **Compare releases**를 누릅니다. `preact@10.24.2`, `@babel/core@latest`처럼 정확한 버전이나 배포 태그를 사용할 수 있습니다.
2. **Top movers**에서 크기 변화가 큰 파일을 찾습니다. 아래 **File ledger**에서 경로를 검색하거나 상태로 거를 수 있습니다. 파일 해시가 있으면 크기가 같은 내용 변경도 표시합니다.
3. 직접 빌드한 패키지는 **Local files**에서 두 파일을 선택합니다. `.tgz`, Atlas 스냅샷, `npm pack --dry-run --json` 출력물을 지원합니다. 로컬 파일은 브라우저 안에서 처리합니다. **Export HTML**을 누르면 인터넷 없이 다시 열 수 있는 비교 보고서를 저장합니다.

파일별 변화량은 압축 해제 후의 바이트 수입니다. 다운로드할 때 받는 압축 파일의 크기는 패키지 전체를 기준으로 표시합니다. [예제 데이터와 원본 tarball](docs/examples/README.md)

## 터미널에서 내 패키지 검사하기

Node.js 22 이상과 npm이 필요합니다. GitHub 릴리스에 올린 버전을 설치한 뒤 검사할 패키지 폴더에서 실행하세요.

```sh
npm install --global https://github.com/hakm12-ship-it/tarball-atlas/releases/download/v1.0.0/tarball-atlas-1.0.0.tgz
tarball-atlas scan .
```

`scan`은 npm의 패키징 미리보기를 사용하며 패키지 스크립트 실행을 끕니다. `package.json`에 `prepare` 스크립트가 있으면 npm 11 이상이 필요합니다. 빌드가 파일을 생성하는 프로젝트에서는 먼저 빌드하세요. Git 저장소에서는 패키지에만 포함된 파일과 Git에서 추적하지만 배포에서 빠지는 파일도 확인할 수 있습니다.

배포하기 전에는 `npm:`으로 지정한 공개 릴리스와 로컬에서 만든 tarball을 직접 비교할 수 있습니다. 예를 들어 같은 폴더에 `preact-10.24.2.tgz`가 있다면 다음 명령으로 공개된 이전 버전과 비교합니다.

```sh
tarball-atlas diff npm:preact@10.24.1 ./preact-10.24.2.tgz --html release-review.html
```

두 체크아웃이 `old`, `new` 폴더에 있다면 상위 폴더에서 각각의 스냅샷을 저장하고 대화형 HTML 보고서를 만드세요.

```sh
tarball-atlas scan ./old --json > before.json
tarball-atlas scan ./new --json > after.json
tarball-atlas diff before.json after.json --html report.html
```

CI에서는 필수 파일, 금지할 경로 패턴, 압축 해제 크기 상한을 한 번에 검사할 수 있습니다. 다음 명령은 `dist/index.js`가 포함되어야 하고, 소스 맵이 없어야 하며, 전체 파일이 500,000바이트 이하여야 통과합니다.

```sh
tarball-atlas scan . --require dist/index.js --forbid "**/*.map" --max-unpacked 500000
```

종료 코드는 성공 시 `0`, 배포 조건을 어기면 `1`, 입력 또는 실행 오류가 있으면 `2`입니다. [릴리스 파일](https://github.com/hakm12-ship-it/tarball-atlas/releases/tag/v1.0.0)
