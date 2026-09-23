// 배포용 zip 생성: node tools/package.mjs
// 커밋된 HEAD 기준으로 확장 실행에 필요한 파일(manifest.json, src/, icons/)만 담는다.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const out = `dist/chzzk-alarm-v${version}.zip`;

const dirty = execFileSync('git', ['status', '--porcelain', '--', 'manifest.json', 'src', 'icons'], { encoding: 'utf8' });
if (dirty.trim()) {
  console.error('manifest.json, src/, icons/에 커밋되지 않은 변경이 있습니다. 커밋 후 다시 실행하세요.');
  process.exit(1);
}

mkdirSync('dist', { recursive: true });
execFileSync('git', ['archive', '--format=zip', '-o', out, 'HEAD', 'manifest.json', 'src', 'icons'], { stdio: 'inherit' });
console.log(out);
