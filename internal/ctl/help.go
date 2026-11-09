package ctl

import (
	"fmt"
	"io"
	"strings"
)

func help(w io.Writer) error {
	fmt.Fprintln(w, `wildtokenctl — WildToken HTTP client

Usage:
  wildtokenctl <command> [ID] [options]
  wildtokenctl commands --json
  wildtokenctl clients pi|opencode [plan|export] --protocol chat|responses|messages
  wildtokenctl skill show|install

Authentication:
  WILDTOKEN_URL                 server root (default http://127.0.0.1:3100)
  WILDTOKEN_ADMIN_TOKEN         admin credential
  WILDTOKEN_TOKEN               downstream credential
  --server URL                 override server
  --admin-token-file FILE       private admin credential file
  --token-file FILE             private downstream credential file
  --token-id ID                 select a downstream token through the admin API
  --admin-token-env NAME        override admin variable name
  --token-env NAME              override downstream variable name
  --allow-http                 explicitly allow remote plaintext HTTP

Common options:
  --file FILE|- / --data JSON   input (never put real secrets in --data)
  --query key=value             repeatable query parameter
  --json                        compact JSON; streams always emit NDJSON
  --out FILE                    new private JSON output file
  --secret-out FILE             new private token/key output file
  --dry-run                     preview without mutation
  --yes                         authorize a mutation or billable probe
  --show-secrets                explicitly include credentials in output
  --timeout 5m                  request deadline (stream headers only)

Client setup / skills:
  --protocol chat|responses|messages   required; never guessed from model IDs
  --model ID                    repeat to select models; otherwise query gateway
  --provider ID                 default wildtoken-<protocol>
  --config PATH                 target config file or skill directory
  --scope user|project          Pi models only support user scope
  --apply --yes                 apply a preview; preserve links and make backups
  --replace                     allow conflicting owned fields to change
  --embed-token                 store a downstream key instead of an env reference
  --context-window N --max-tokens N --reasoning --vision
                                only declare verified capabilities

API commands (PUT updates accept partial JSON and read the current record first):`)
	for _, command := range commands {
		parameters := ""
		if strings.Contains(command.Path, "{id}") {
			parameters += " ID"
		}
		if strings.Contains(command.Path, "{field}") {
			parameters += " FIELD"
		}
		if command.Input {
			parameters += " --file JSON"
		}
		if command.Mutates {
			parameters += " --yes"
		}
		if _, err := fmt.Fprintf(w, "  %s%s\n", command.Name, parameters); err != nil {
			return err
		}
	}
	return nil
}
