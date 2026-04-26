// Toolkit single-binary entry point.
//
// Subcommands:
//   toolkit api      — HTTP/WS API server
//   toolkit worker   — background job worker
//   toolkit migrate  — database migration runner
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/softservice/toolkit/internal/config"
	"github.com/softservice/toolkit/internal/logging"
	"github.com/softservice/toolkit/internal/migrate"
	"github.com/softservice/toolkit/internal/server"
	"github.com/softservice/toolkit/internal/worker"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	mode := os.Args[1]
	logger := logging.New()

	cfg, err := config.Load()
	if err != nil {
		logger.Error("config load failed", "err", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	switch mode {
	case "api":
		if err := server.Run(ctx, cfg, logger); err != nil {
			logger.Error("api terminated", "err", err)
			os.Exit(1)
		}
	case "worker":
		if err := worker.Run(ctx, cfg, logger); err != nil {
			logger.Error("worker terminated", "err", err)
			os.Exit(1)
		}
	case "migrate":
		if err := migrate.RunFromArgs(os.Args[2:], cfg, logger); err != nil {
			logger.Error("migrate failed", "err", err)
			os.Exit(1)
		}
	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: toolkit <api|worker|migrate> [args...]")
}
