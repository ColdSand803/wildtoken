// Command wildtokenctl manages an existing WildToken service over HTTP.
package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/liguangsheng/wildtoken/internal/ctl"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	os.Exit(ctl.Run(ctx, os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}
