// Package migrate wraps golang-migrate for database schema management.
package migrate

import (
	"errors"
	"flag"
	"fmt"
	"log/slog"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	_ "github.com/golang-migrate/migrate/v4/source/file"

	"github.com/softservice/toolkit/internal/config"
)

func RunFromArgs(args []string, cfg *config.Config, logger *slog.Logger) error {
	fs := flag.NewFlagSet("migrate", flag.ContinueOnError)
	cmd := fs.String("cmd", "up", "one of: up | down | goto | force | version")
	steps := fs.Int("n", 0, "steps for up/down (0 = all)")
	version := fs.Int("version", 0, "version for goto/force")
	if err := fs.Parse(args); err != nil {
		return err
	}

	dbURL := pgxMigrateURL(cfg.DatabaseURL)

	m, err := migrate.New(cfg.MigrationsPath, dbURL)
	if err != nil {
		return fmt.Errorf("migrate init: %w", err)
	}
	defer func() {
		sErr, dErr := m.Close()
		if sErr != nil {
			logger.Warn("migrate source close", "err", sErr)
		}
		if dErr != nil {
			logger.Warn("migrate db close", "err", dErr)
		}
	}()

	switch *cmd {
	case "up":
		if *steps > 0 {
			err = m.Steps(*steps)
		} else {
			err = m.Up()
		}
	case "down":
		if *steps > 0 {
			err = m.Steps(-*steps)
		} else {
			err = m.Down()
		}
	case "goto":
		err = m.Migrate(uint(*version))
	case "force":
		err = m.Force(*version)
	case "version":
		v, dirty, vErr := m.Version()
		if vErr != nil {
			if errors.Is(vErr, migrate.ErrNilVersion) {
				logger.Info("migration version", "version", "none", "dirty", false)
				return nil
			}
			return vErr
		}
		logger.Info("migration version", "version", v, "dirty", dirty)
		return nil
	default:
		return fmt.Errorf("unknown cmd: %s", *cmd)
	}

	if err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return err
	}
	logger.Info("migrate done", "cmd", *cmd)
	return nil
}

// pgxMigrateURL converts a postgres:// URL into the scheme golang-migrate's
// pgx/v5 driver expects.
func pgxMigrateURL(u string) string {
	if len(u) >= 11 && u[:11] == "postgres://" {
		return "pgx5://" + u[11:]
	}
	if len(u) >= 13 && u[:13] == "postgresql://" {
		return "pgx5://" + u[13:]
	}
	return u
}
