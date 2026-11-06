package ctl

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

type stringsFlag []string

func (v *stringsFlag) String() string         { return strings.Join(*v, ",") }
func (v *stringsFlag) Set(value string) error { *v = append(*v, value); return nil }

type options struct {
	server, adminEnv, tokenEnv, adminFile, tokenFile, tokenID       string
	file, data, out, secretOut, config, scope, provider, protocol   string
	query, models                                                   stringsFlag
	timeout                                                         time.Duration
	yes, dryRun, showSecrets, allowHTTP, apply, replace, embedToken bool
	reasoning, vision, json, help, version                          bool
	contextWindow, maxTokens                                        int
}

func parse(args []string, stderr io.Writer) (options, []string, error) {
	o := options{}
	f := flag.NewFlagSet("wildtokenctl", flag.ContinueOnError)
	f.SetOutput(stderr)
	server := os.Getenv("WILDTOKEN_URL")
	if server == "" {
		server = "http://127.0.0.1:3100"
	}
	f.StringVar(&o.server, "server", server, "WildToken server URL")
	f.StringVar(&o.adminEnv, "admin-token-env", "WILDTOKEN_ADMIN_TOKEN", "admin credential environment variable")
	f.StringVar(&o.tokenEnv, "token-env", "WILDTOKEN_TOKEN", "downstream credential environment variable")
	f.StringVar(&o.adminFile, "admin-token-file", "", "read admin credential from file")
	f.StringVar(&o.tokenFile, "token-file", "", "read downstream credential from file")
	f.StringVar(&o.tokenID, "token-id", "", "use a downstream token by ID via admin API")
	f.DurationVar(&o.timeout, "timeout", 30*time.Second, "request timeout; streams use only a header timeout")
	f.BoolVar(&o.allowHTTP, "allow-http", false, "allow credentials over remote plaintext HTTP")
	f.StringVar(&o.file, "file", "", "JSON input file; - reads stdin")
	f.StringVar(&o.data, "data", "", "JSON input (avoid secrets on the command line)")
	f.StringVar(&o.out, "out", "", "write output to a new private file")
	f.StringVar(&o.secretOut, "secret-out", "", "write a returned token or API key to a new private file")
	f.Var(&o.query, "query", "query key=value; repeatable")
	f.BoolVar(&o.yes, "yes", false, "authorize a mutation or billable probe")
	f.BoolVar(&o.dryRun, "dry-run", false, "show a request without executing it")
	f.BoolVar(&o.showSecrets, "show-secrets", false, "explicitly allow credentials in output")
	f.BoolVar(&o.json, "json", false, "compact JSON; streams always emit NDJSON")
	f.BoolVar(&o.help, "help", false, "show help")
	f.BoolVar(&o.help, "h", false, "show help")
	f.BoolVar(&o.version, "version", false, "show version")
	f.StringVar(&o.config, "config", "", "client configuration path or skill directory")
	f.StringVar(&o.scope, "scope", "user", "user or project scope")
	f.StringVar(&o.provider, "provider", "", "provider ID; default wildtoken-<protocol>")
	f.StringVar(&o.protocol, "protocol", "", "chat, responses or messages; required for client setup")
	f.Var(&o.models, "model", "model ID; repeatable (otherwise query the server)")
	f.IntVar(&o.contextWindow, "context-window", 0, "verified context size; 0 leaves the client default")
	f.IntVar(&o.maxTokens, "max-tokens", 0, "verified output limit; 0 leaves the client default")
	f.BoolVar(&o.reasoning, "reasoning", false, "declare thinking support")
	f.BoolVar(&o.vision, "vision", false, "declare image input support")
	f.BoolVar(&o.apply, "apply", false, "apply the configuration/skill plan")
	f.BoolVar(&o.replace, "replace", false, "allow replacing conflicting configuration values")
	f.BoolVar(&o.embedToken, "embed-token", false, "store a downstream key in the client configuration")
	// Standard flag parsing stops at a positional argument. Collect flags so
	// both 'ctl --server URL status' and 'ctl status --server URL' work.
	var flags, positionals []string
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			positionals = append(positionals, args[i+1:]...)
			break
		}
		if !strings.HasPrefix(arg, "-") || arg == "-" {
			positionals = append(positionals, arg)
			continue
		}
		name, _, assigned := strings.Cut(strings.TrimLeft(arg, "-"), "=")
		entry := f.Lookup(name)
		if entry == nil {
			return o, nil, fmt.Errorf("unknown option --%s", name)
		}
		flags = append(flags, arg)
		boolean, ok := entry.Value.(interface{ IsBoolFlag() bool })
		if !assigned && !(ok && boolean.IsBoolFlag()) {
			i++
			if i >= len(args) {
				return o, nil, fmt.Errorf("--%s requires a value", name)
			}
			flags = append(flags, args[i])
		}
	}
	if err := f.Parse(flags); err != nil {
		return o, nil, err
	}
	if o.file != "" && o.data != "" {
		return o, nil, errors.New("--file and --data cannot be combined")
	}
	if o.apply && o.dryRun {
		return o, nil, errors.New("--apply and --dry-run cannot be combined")
	}
	return o, positionals, nil
}
