---
title: サポート
layout: default
nav_order: 6
---

# サポート・質問

## 質問は GitHub Issue でお願いします

**このプロジェクトの質問はすべて [GitHub Issue](https://github.com/makoto-developer/strata/issues) で受け付けます。**
Discussions やチャットは用意していません。理由は、質問と回答が**検索できる形で 1 か所に残る**方が、
後から同じことで困った人の役に立つからです。

| 種類 | リンク |
| --- | --- |
| ❓ 使い方・設定・結果の読み方の質問 | [質問を作成](https://github.com/makoto-developer/strata/issues/new?template=3_question.yml) |
| 🐛 バグ報告(解析がおかしい・落ちる) | [バグを報告](https://github.com/makoto-developer/strata/issues/new?template=1_bug_report.yml) |
| 💡 機能リクエスト | [提案する](https://github.com/makoto-developer/strata/issues/new?template=2_feature_request.yml) |
| 🔐 脆弱性 | [セキュリティ勧告(非公開)](https://github.com/makoto-developer/strata/security/advisories/new) |

「初歩的すぎるかも」と迷う必要はありません。**使い方が分かりにくいのはドキュメント側の問題**なので、
質問はそのまま改善の材料になります。

## 質問するときにあると助かる情報

- `strata --version` の出力
- 実行したコマンドと、実際の出力(そのまま貼ってください)
- 対象の言語・フレームワーク(gin / Express / gqlgen など)
- 可能なら、再現する最小のコード片

社外に出せないコードの場合は、**構造だけ**(ディレクトリ構成や、パスを伏せた擬似コード)でも構いません。

## 想定される回答時間

個人で開発しているため即応は保証できませんが、目安として**数日以内**に一次返信します。
急ぎの場合はその旨を書いてください。

## よくある質問

### 依存があるはずなのに線が出ません

Strata は「候補が一意に決まるときだけ」線を引きます。次のケースは意図的に検出しません。

- interface 越しの呼び出し(Go の interface、TS の DI)で実装が複数あるとき
- 同じパスの HTTP ルートが複数サービスにあるとき
- 変数だけで組み立てた URL / 動的な import

限界は[仕様書 §6.8](https://github.com/makoto-developer/strata/blob/main/docs/SPEC.md)に明記しています。

### 「未使用?」と出ますが本当に消していいですか

「このリポジトリの本番コードから呼び出しを検出できなかった」という意味です。
別リポジトリのクライアント・リフレクション・外部からの直接アクセスは検出できません。
消す前に、まず**外部からの流入経路(API Gateway のログ等)**を確認してください。

### モノレポではなく複数リポジトリです

「プロジェクト」タブで複数のリポジトリを登録し、**複合プロジェクト**として 1 つのグラフにできます。
