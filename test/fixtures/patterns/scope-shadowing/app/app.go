// 同じ client という変数名で、関数ごとに別の service を掴んでいる。
package app

import (
	"context"

	opspb "example.com/acme/proto/ops"
)

// lookupUser は利用者を引く。
func lookupUser(ctx context.Context, conn Conn) error {
	client := opspb.NewUserServiceClient(conn)
	_, err := client.Lookup(ctx, &opspb.LookupRequest{})
	return err
}

// lookupAdmin は管理者を引く。
func lookupAdmin(ctx context.Context, conn Conn) error {
	client := opspb.NewAdminServiceClient(conn)
	_, err := client.Lookup(ctx, &opspb.LookupRequest{})
	return err
}
