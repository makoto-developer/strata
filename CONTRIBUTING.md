# コントリビューションについて / Contributing

Pull Request・Issue は歓迎します。ありがとうございます!

このドキュメントは「どう関わればよいか」を最短で分かるようにするためのものです。
使い方や設計の意図は [ドキュメントサイト](https://makoto-developer.github.io/strata/) にあります。

## 質問は Issue でお願いします

**このプロジェクトの質問はすべて GitHub Issue で受け付けます。**
Discussions やチャットは用意していません。理由は、質問と回答が
**検索できる形で 1 か所に残る**方が、後から来た人の役に立つからです。

- 質問 → [❓ 質問テンプレート](https://github.com/makoto-developer/strata/issues/new?template=3_question.yml)
- バグ → [🐛 バグ報告テンプレート](https://github.com/makoto-developer/strata/issues/new?template=1_bug_report.yml)
- 提案 → [💡 機能リクエスト](https://github.com/makoto-developer/strata/issues/new?template=2_feature_request.yml)
- 脆弱性 → 公開 Issue ではなく [セキュリティ勧告](https://github.com/makoto-developer/strata/security/advisories/new) から(詳細は [SECURITY.md](SECURITY.md))

「初歩的すぎるかも」と迷う必要はありません。使い方が分かりにくいのは
ドキュメント側の課題なので、質問はそのままドキュメント改善の材料になります。

## ライセンスと貢献の条件(軽量 CLA)

このプロジェクトは **AGPL-3.0-only** で公開されています。

Pull Request を提出した時点で、以下に同意したものとみなします:

1. 貢献したコードはあなた自身が作成したものであり、第三者の権利を侵害していないこと
2. 貢献は本プロジェクトのライセンス(AGPL-3.0)の下で提供されること
3. プロジェクトメンテナ(リポジトリオーナー)が、貢献を含むプロジェクト全体を
   **将来別のライセンスで再許諾(デュアルライセンス等)する権利**を持つこと

3 は「プロジェクトが特定の企業などに囲い込まれないよう AGPL を維持しつつ、
メンテナがライセンス方針を決められる状態を保つ」ための条件です。
同意できない場合は、PR ではなく Issue での提案・報告をお願いします。

*By submitting a pull request, you certify that the contribution is your own work,
agree to license it under AGPL-3.0, and grant the project maintainer the right to
relicense the project (including your contribution) under other terms in the future.*

## 開発の始め方

```bash
git clone https://github.com/makoto-developer/strata.git
cd strata

# 依存ゼロ・ビルド不要(Node.js >= 22.18 の型ストリッピングで TS を直接実行)
node src/cli.ts serve examples/demo

npm test              # スモークテスト(test/*.mjs)
npm run typecheck     # tsc --noEmit(エラー 0 件を維持)
```

`npm install` は**開発でも基本的に不要**です(devDependencies は typecheck 用の
typescript / @types/node のみ)。スクリーンショット確認やバイナリビルドのときだけ、
`npm install --no-save playwright` のように都度入れます。

## この 4 つを守ってもらえると助かります

### 1. グラフに出ている依存は実在すること

Strata は「取りこぼしても良いが、嘘は出さない」方針です(docs/SPEC.md §6.8)。
解析を足すときは、**候補が一意に決まるときだけ辺を張る**という既存の方針に合わせてください。
判定を緩めて偽陽性が増える変更は、たとえ検出数が増えても受け入れられません。

### 2. 解析の変更には回帰テストを添える

`examples/demo` に最小のフィクスチャを足し、`test/cli.smoke.mjs` に
「この入力からこの辺が出る」というアサーションを書いてください。
言語アナライザの修正は、実際のリポジトリで**偽陰性が消え、偽陽性が増えていない**ことも確認してください
(大きめの検証用サンプルとして [strata-sample-platform](https://github.com/makoto-developer/strata-sample-platform) があります)。

### 3. 依存を増やさない

- 本体(`src/`)とビューア(`web/`)は**実行時依存ゼロ**が設計原則です
- ビューアは外部 JS/CSS ライブラリを使いません(フレームワークも入れません)
- ビルド専用ツール(esbuild など)は `--no-save` で都度入れる形にしてください

### 4. 仕様書も一緒に直す

挙動を変える PR は [docs/SPEC.md](docs/SPEC.md) の該当節も更新してください。SPEC が正です。
ユーザーから見える変更なら README とドキュメントサイト(`docs/`)も対象です。

## PR を出す前に

**1 コマンドで全部確認できます。**

```sh
npm run check     # 型チェック → リント → テスト → ドキュメント整合
```

内訳(個別にも実行できます):

| コマンド | 何を見るか |
| --- | --- |
| `npm run typecheck` | TypeScript の型エラー(`tsc --noEmit`、エラー 0 を維持) |
| `npm run lint` | このリポジトリの約束事(行末空白・タブ・`any`・`console.log`・TODO の置き忘れ) |
| `npm test` | CLI / 解析エンジン / ビューア(DOM スタブ) / サーバ(HTTP)のスモークテスト |
| `npm run docs:check` | ドキュメントの front matter・ナビ・内部リンク・画像参照 |

`npm run check` は CI と同じ内容です。**これが緑なら CI も通ります**(devDependencies の
インストールだけ必要: `npm ci`)。

リンターに ESLint 等を使っていないのは、「実行時依存ゼロ・開発でも `npm install` を
基本不要にする」方針のためです。汎用の整形ルールではなく、このプロジェクトが実際に
守りたいことだけを [`scripts/lint.mjs`](scripts/lint.mjs) で見ています。

## PR の出し方

1. **まずドラフト(Draft PR)で作ってください。** レビュー可能になってから Ready にします。
   ドラフトのうちは「作業中である」ことが一目で分かり、無駄なレビューが発生しません。
   Ready にする条件は次の 3 つです:
   - `npm run check` が緑
   - PR テンプレートのチェックリストを埋めた
   - 何を・なぜ変えるのかが説明に書いてある
2. コミットメッセージは [Conventional Commits](https://www.conventionalcommits.org/ja/v1.0.0/) 風に
   (`feat:` / `fix:` / `docs:` / `refactor:` / `test:`)。日本語本文で構いません
3. 1 PR = 1 目的。無関係な整形は分けてください
4. ビューアを変えたときは **light / dark 両方のスクリーンショット**を貼ってください
   (`node scripts/shots.mjs http://127.0.0.1:7333/ /tmp/shots after` で一括撮影できます)

## コードスタイル

- インデント 2 スペース、セミコロンあり、シングルクォート
- コメントは**「なぜそうしたか」**を書く(何をしているかはコードで分かる)。日本語で構いません
- `src/` は TypeScript(strict)。`any` を足すときは理由をコメントに残してください
- ファイル冒頭に、そのモジュールの役割と対応する SPEC の節番号を書く慣習です

## Issue と PR の運用ルール

### ラベル

ラベルの定義は [.github/labels.yml](.github/labels.yml) が正です。3 系統に分けています。

| 系統 | 付け方 | 例 |
| --- | --- | --- |
| **type** | 必ず 1 つ | `bug` / `enhancement` / `question` / `documentation` / `refactor` / `security` |
| **status** | 必ず 1 つ。状況が動いたら更新する | `status: triage` → `status: needs info` / `status: accepted` → `status: in progress` |
| **area** | 任意・複数可 | `area: analyzer` / `area: viewer` / `area: cli` / `area: docs` / `area: ci` |

`priority: high` は「実用を妨げるので優先して直す」ものだけに付けます(付いていなければ通常対応)。

### Issue のライフサイクル

1. **受付**: テンプレートから作成されると `status: triage` が付いた状態で始まります
2. **トリアージ**(メンテナ): 再現できるかを確認し、`type` と `area` を付けます
   - 情報が足りない → `status: needs info`。**14 日返答がなければ close** します(再開はいつでも歓迎)
   - 対応する → `status: accepted`。対応しない → 理由をコメントして `wontfix` で close
3. **着手**: `status: in progress`。PR には `Closes #<番号>` を書きます
4. **完了**: PR のマージで自動 close

質問(`question`)は解決したら close します。回答が他の人の役に立ちそうなら、
その内容をドキュメントに反映してから閉じます(**質問はドキュメントの不足を示す信号**として扱います)。

### PR のルール

- **まずドラフトで作る**。CI が緑になり、説明が書けたら Ready にしてください
- **1 PR = 1 目的**。無関係な整形は別 PR に分けてください
- タイトルは [Conventional Commits](https://www.conventionalcommits.org/ja/v1.0.0/) 形式
  (`feat:` / `fix:` / `docs:` / `refactor:` / `test:` / `chore:`)。本文は日本語で構いません
- **必須条件**(PR テンプレートのチェックリストと同じ):
  - `npm test` と `npm run typecheck` が通る
  - 解析エンジンの変更には**回帰テストを添える**
  - ビューアの変更には **light / dark 両方のスクリーンショット**を貼る
  - ユーザーから見える変更は README / docs も更新する
- **マージ方式**: メンテナが squash merge します(履歴を 1 変更 = 1 コミットに保つため)
- レビューは基本的に 1 人(メンテナ)です。返答は数日以内を目安にします

### 破壊的変更とリリース

- 0.x のうちは後方互換を保証しません。挙動が変わる変更は PR の説明に **「破壊的変更」** と明記してください
- リリースはタグ(`vX.Y.Z`)を push すると自動で作られます。バイナリの添付・リリースノートの生成も自動です
- 解析結果(モデル JSON)のスキーマを変える場合は、`docs/SPEC.md` §7 の更新を必ず含めてください

## リポジトリの構成

| パス | 役割 |
| --- | --- |
| `src/cli.ts` | コマンド分岐(scan / serve / export / check / trace / report / diff / metrics / init) |
| `src/scan.ts` | 走査とアナライザのオーケストレーション |
| `src/analyzers/` | 言語・プロトコル別の解析(go / jsts / python / elixir / proto / http / graphql / messaging) |
| `src/server.ts` | ローカルサーバー(ビューア配信 / source / files / blame / commit) |
| `web/` | ビューア(素の HTML / CSS / JS) |
| `docs/` | 仕様書とドキュメントサイト(GitHub Pages) |
| `test/` | スモークテスト |
| `scripts/` | 開発補助(デモ録画・スクリーンショット・バイナリビルド) |
