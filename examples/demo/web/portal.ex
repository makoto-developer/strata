# Elixir フロントエンドの gRPC 呼び出し例。
# get_user_by_id → GetUserByID(頭字語)の突き合わせのリグレッションケース。
defmodule Demo.Portal do
  alias User.V1.{
    UserService.Stub,
    GetUserRequest
  }

  # ポータル画面の初期表示でユーザーを読み込む
  def load_user(channel, id) do
    Stub.get_user_by_id(channel, %GetUserRequest{id: id})
  end
end
