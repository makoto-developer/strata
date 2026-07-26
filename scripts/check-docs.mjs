// ドキュメントサイト(docs/)の整合性チェック。
// Jekyll を動かさずに、公開後に 404 やナビ崩れになる原因だけを機械的に潰す。
//
//   node scripts/check-docs.mjs
//
// 検査内容:
//   1. すべての .md に front matter があるか(無いと Pages でページにならない)
//   2. front matter の parent が、実在するページの title を指しているか(just-the-docs のナビ)
//   3. {{ site.baseurl }}/... の内部リンクが実在するページを指しているか
//   4. nav_order の重複(並びが不定になる)

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../docs', import.meta.url));
const errors = [];

/** docs/ 配下の .md を再帰的に集める。 */
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name.endsWith('.md')) out.push(p);
  }
  return out;
}

const files = walk(root).sort();
const pages = new Map(); // 絶対パス -> front matter

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(root, file);
  if (!src.startsWith('---')) {
    errors.push(`${rel}: front matter がありません(Pages のページとして公開されません)`);
    continue;
  }
  const fm = src.split('---')[1] ?? '';
  const meta = {};
  for (const m of fm.matchAll(/^(\w+):\s*(.+)$/gm)) meta[m[1]] = m[2].trim();
  pages.set(file, meta);
}

const titles = new Set([...pages.values()].map((m) => m.title).filter(Boolean));

// スラッグ(permalink: pretty のときの URL パス)
const slugs = new Set();
for (const file of pages.keys()) {
  const rel = path.relative(root, file).replace(/\.md$/, '');
  slugs.add(rel === 'index' ? '' : rel.replace(/\/index$/, ''));
}

for (const [file, meta] of pages) {
  const rel = path.relative(root, file);
  if (meta.parent && !titles.has(meta.parent)) {
    errors.push(`${rel}: parent "${meta.parent}" に一致する title のページがありません`);
  }
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/\{\{\s*site\.baseurl\s*\}\}\/([^)\s"']*)/g)) {
    const target = m[1].split('#')[0].replace(/^\/+|\/+$/g, '');
    if (target === '') continue;
    // 拡張子つき(画像などの静的ファイル)は実ファイルの存在を見る
    if (/\.[a-z0-9]+$/i.test(target)) {
      if (!fs.existsSync(path.join(root, target))) {
        errors.push(`${rel}: 参照しているファイルがありません → docs/${target}`);
      }
      continue;
    }
    if (!slugs.has(target)) errors.push(`${rel}: 内部リンクの宛先がありません → /${target}/`);
  }
}

// 同じ階層で nav_order が重複していないか
const byParent = new Map();
for (const [file, meta] of pages) {
  const key = meta.parent ?? '(root)';
  if (!byParent.has(key)) byParent.set(key, []);
  byParent.get(key).push({ file, order: meta.nav_order });
}
for (const [parent, list] of byParent) {
  const seen = new Map();
  for (const { file, order } of list) {
    if (order === undefined) continue;
    if (seen.has(order)) {
      errors.push(
        `nav_order ${order} が重複しています(${parent}): ` +
          `${path.relative(root, seen.get(order))} と ${path.relative(root, file)}`,
      );
    }
    seen.set(order, file);
  }
}

console.log(`ドキュメント ${pages.size} ページを検査しました`);
if (errors.length > 0) {
  for (const e of errors) console.error('✖ ' + e);
  process.exit(1);
}
console.log('✓ front matter・ナビの親子関係・内部リンク・nav_order は整合しています');
