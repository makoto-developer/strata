// GraphQL ドキュメントを組み立てる最小のタグ関数(デモ用)。
export function gql(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ''), '');
}
