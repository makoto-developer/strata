// 同じパスを、社内と社外の 2 か所へ呼ぶ。
// パスだけで照合するとどちらも社内ルートに繋がってしまう(嘘の社内依存)。
package main

import (
	"fmt"
	"net/http"
)

// internalHosts に書いてあるので社内ルートへ繋がってよい
func fetchInternal(id string) {
	http.Get(fmt.Sprintf("https://internal.example.com/users/%s", id))
}

// 別会社。パスが同じでも社内ルートへ繋いではいけない
func fetchPartner(id string) {
	http.Get(fmt.Sprintf("https://partner.example.com/users/%s", id))
}

func main() { fetchInternal("x"); fetchPartner("y") }
