#!/usr/bin/env node
// public/index.html → demo/index.html: 서버 없이 도는 체험판 페이지(Claude Artifact 등 정적 호스팅용).
// demo-api.js가 /api/* 요청을 브라우저 안에서 처리한다. 함께 올릴 파일: styles.css, app.js, demo-api.js, lib/*.js
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const src = await readFile(join(ROOT, 'public', 'index.html'), 'utf8');
const head = src.match(/<head>([\s\S]*?)<\/head>/)[1]
  .replace(/\s*<meta charset[^>]*>|\s*<meta name="viewport"[^>]*>/g, '')
  .replace('href="/styles.css"', 'href="styles.css"')
  .replace('<title>아기 공구 모아보기</title>', '<title>아기 공구 모아보기</title>\n  <meta name="claude:viewport-fit-sides" content="cover">');
const body = src.match(/<body>([\s\S]*?)<\/body>/)[1]
  .replace('<script type="module" src="/app.js"></script>', '<script type="module" src="demo-api.js"></script>\n  <script type="module" src="app.js"></script>')
  .replace('<div id="sample-banner" class="banner" hidden>', '<div class="banner">체험판이에요. 제보한 공구는 이 브라우저에만 저장돼요.</div>\n    <div id="sample-banner" class="banner" hidden>');
await mkdir(join(ROOT, 'demo'), { recursive: true });
await writeFile(join(ROOT, 'demo', 'index.html'), head.trim() + '\n' + body.trim() + '\n');
console.log('demo/index.html 생성 완료');
