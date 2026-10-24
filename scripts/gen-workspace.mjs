// README に載せる性能値を誰でも再現できるようにするための、合成ワークスペース生成器。
//
// 手元の実リポジトリで測った数字は検証できない。このツールは「実装とずれない」ことを
// 売りにしているので、自分の主張も追試できる形でなければ筋が通らない。
//
// 使い方:
//   node scripts/gen-workspace.mjs /tmp/strata-bench 30
//   time node src/cli.ts scan /tmp/strata-bench > /dev/null
//
// 出力は入力(出力先・サービス数)だけで決まる。乱数は使わない。

import * as fs from 'node:fs';
import * as path from 'node:path';

const outDir = path.resolve(process.argv[2] ?? '/tmp/strata-bench');
const services = Number(process.argv[3] ?? 30);
if (!Number.isInteger(services) || services < 1) {
  console.error('サービス数は 1 以上の整数で指定してください');
  process.exit(1);
}

const PKGS = ['api', 'usecase', 'repository', 'domain', 'infra'];
const write = (rel, body) => {
  const abs = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};

fs.rmSync(outDir, { recursive: true, force: true });

for (let i = 0; i < services; i++) {
  const name = `svc${String(i).padStart(3, '0')}`;
  const mod = `example.com/bench/${name}`;
  const peer = `svc${String((i + 1) % services).padStart(3, '0')}`;

  write(`proto/${name}/v1/${name}.proto`, [
    'syntax = "proto3";',
    '',
    `package bench.${name}.v1;`,
    '',
    `option go_package = "example.com/bench/proto/${name}/v1;${name}v1";`,
    '',
    `service ${name}Service {`,
    ...Array.from({ length: 4 }, (_, r) => `  rpc Op${r}(Op${r}Req) returns (Op${r}Res);`),
    '}',
    '',
    ...Array.from({ length: 4 }, (_, r) => `message Op${r}Req { string id = 1; }\nmessage Op${r}Res { string v = 1; }`),
    '',
  ].join('\n'));

  write(`services/${name}/go.mod`, `module ${mod}\n\ngo 1.22\n`);
  write(`services/${name}/cmd/main.go`, [
    'package main',
    '',
    `import "${mod}/internal/api"`,
    '',
    'func main() { api.New().Serve() }',
    '',
  ].join('\n'));

  for (const [depth, pkg] of PKGS.entries()) {
    const next = PKGS[depth + 1];
    write(`services/${name}/internal/${pkg}/${pkg}.go`, [
      `package ${pkg}`,
      '',
      'import (',
      '\t"context"',
      '',
      `\t${name}v1 "example.com/bench/proto/${name}/v1"`,
      ...(next ? [`\t"${mod}/internal/${next}"`] : []),
      ...(pkg === 'usecase' ? [`\tpeerv1 "example.com/bench/proto/${peer}/v1"`] : []),
      ')',
      '',
      `type ${pkg}Handler struct {`,
      ...(next ? [`\tnext *${next}.${next}Handler`] : []),
      ...(pkg === 'usecase' ? [`\tpeer peerv1.${peer}ServiceClient`] : []),
      '}',
      '',
      `func New() *${pkg}Handler { return &${pkg}Handler{} }`,
      '',
      `func (h *${pkg}Handler) Serve() {}`,
      '',
      ...Array.from({ length: 4 }, (_, r) => [
        `func (h *${pkg}Handler) Op${r}(ctx context.Context, req *${name}v1.Op${r}Req) (*${name}v1.Op${r}Res, error) {`,
        ...(next ? [`\th.next.Op${r}(ctx, req)`] : []),
        ...(pkg === 'usecase' ? [`\th.peer.Op${r}(ctx, &peerv1.Op${r}Req{Id: req.Id})`] : []),
        `\treturn &${name}v1.Op${r}Res{}, nil`,
        '}',
      ].join('\n')),
      '',
    ].join('\n'));
  }
}

let files = 0;
const count = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) count(path.join(d, e.name));
    else files++;
  }
};
count(outDir);
console.log(`${outDir}: ${services} サービス / ${files} ファイル`);
