// どちらのチームの ReportService を呼んでいるか、コードからは決まらない。
package caller

import (
	"context"

	reportpb "example.com/somewhere/reportclient"
)

type Job struct {
	reports reportpb.ReportServiceClient
}

// Run は帳票を書き出す。
func (j *Job) Run(ctx context.Context, id string) error {
	_, err := j.reports.Export(ctx, &reportpb.ExportRequest{Id: id})
	return err
}
