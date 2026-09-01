// 検索は生成クライアント(connect 形式)経由で呼ぶ。
import { createPromiseClient } from '@connectrpc/connect'
import { SearchService } from 'acme-web-clients/search/v1/search_connect'

const transport = makeTransport()
const searchClient = createPromiseClient(SearchService, transport)

/** 検索語から候補一覧を返す。 */
export async function searchTitles(q: string): Promise<string[]> {
  const res = await searchClient.query({ q })
  return res.hits
}
