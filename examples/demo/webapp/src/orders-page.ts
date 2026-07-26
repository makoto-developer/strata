// フロントエンドからの API 利用(GraphQL 操作 + REST 呼び出し)。
// Strata の GraphQL クライアント検出・HTTP クライアント検出のフィクスチャ。
import { gql } from './gqlclient';

const USER_QUERY = gql`
  query UserWithOrders($id: ID!) {
    user(id: $id) {
      id
      name
    }
  }
`;

const CREATE_ORDER = gql`
  mutation Create($userId: ID!, $sku: String!) {
    createOrder(userId: $userId, sku: $sku) {
      id
    }
  }
`;

export async function loadUser(id: string): Promise<unknown> {
  return request(USER_QUERY, { id });
}

export async function placeOrder(userId: string, sku: string): Promise<unknown> {
  return request(CREATE_ORDER, { userId, sku });
}

// API のベース URL は環境変数から差し込む(テンプレートリテラルでの URL 組み立て)
const API_BASE = process.env.API_BASE ?? '';

/** ユーザー情報は gateway の REST から取る。 */
export async function fetchUserProfile(id: string): Promise<unknown> {
  const res = await fetch(`${API_BASE}/api/users/${id}`);
  return res.json();
}

/** REST 側(gateway の /api/orders)も併用する。 */
export async function reorder(userId: string): Promise<unknown> {
  const res = await fetch('/api/orders', {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
  return res.json();
}

async function request(doc: string, variables: Record<string, unknown>): Promise<unknown> {
  const res = await fetch('/graphql', { method: 'POST', body: JSON.stringify({ query: doc, variables }) });
  return res.json();
}
