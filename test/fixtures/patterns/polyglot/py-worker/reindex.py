"""再索引ワーカー。検索サービスへ生成スタブ経由で問い合わせる。"""

import search_pb2_grpc


def build_index(channel, prefix):
    """入力補完の候補を集めて索引を作り直す。"""
    stub = search_pb2_grpc.SearchServiceStub(channel)
    res = stub.Suggest(prefix=prefix)
    return list(res.words)
