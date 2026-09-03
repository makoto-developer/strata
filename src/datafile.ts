// YAML / JSON の「データファイル」を 1 回の読み取りで種別分けする。
//
// OpenAPI 仕様書と Kubernetes マニフェストは、どちらも名前だけでは判別できない
// (api.yaml / deployment.yaml / values.yaml のどれもありうる)。中身の先頭を見るしかないが、
// 種別ごとに開き直すとファイル数ぶんの syscall が二重になる。ここで 1 回だけ読む。

import * as fs from 'node:fs';
import * as path from 'node:path';

const SNIFF_BYTES = 4096;
const MAX_BYTES = 8 * 1024 * 1024;

export type DataFileKind = 'openapi' | 'k8s';

/** 仕様書らしいファイル名(中身を読まずに判定できる速い経路)。 */
export function looksLikeSpecName(base: string): boolean {
  return /(^|[._-])(openapi|swagger)([._-]|$)/i.test(base.replace(/\.(ya?ml|json)$/i, ''));
}

/** 先頭に openapi: / swagger: があるか。 */
export function sniffSpec(text: string): boolean {
  return /^\s*"?(openapi|swagger)"?\s*:\s*["']?\d/m.test(text.slice(0, SNIFF_BYTES));
}

/**
 * Kubernetes マニフェストか。apiVersion と kind の両方を要求する。
 * kind: だけだと、たまたま kind というキーを持つ設定ファイルを拾ってしまう。
 */
export function sniffK8s(text: string): boolean {
  const head = text.slice(0, SNIFF_BYTES);
  return /^\s*"?apiVersion"?\s*:/m.test(head) && /^\s*"?kind"?\s*:/m.test(head);
}

/** 名前と先頭 4KB から種別を決める。どちらでもなければ undefined。 */
export function classifyDataFile(absPath: string, rel: string): DataFileKind | undefined {
  const base = path.posix.basename(rel);
  if (!/\.(ya?ml|json)$/i.test(base)) return undefined;
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile() || st.size > MAX_BYTES) return undefined;
    if (looksLikeSpecName(base)) return 'openapi';
    const fd = fs.openSync(absPath, 'r');
    let head: string;
    try {
      const buf = Buffer.alloc(SNIFF_BYTES);
      const read = fs.readSync(fd, buf, 0, SNIFF_BYTES, 0);
      head = buf.subarray(0, read).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    if (sniffSpec(head)) return 'openapi';
    if (sniffK8s(head)) return 'k8s';
    return undefined;
  } catch {
    return undefined;
  }
}
