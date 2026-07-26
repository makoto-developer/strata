import { formatUser } from './format';

export function header(): string {
  return 'user: ';
}

// format への逆依存 = 意図的な循環(赤表示のデモ用)
export function preview(): string {
  return formatUser({ name: 'preview' });
}
