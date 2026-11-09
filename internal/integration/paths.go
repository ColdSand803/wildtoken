package integration

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/liguangsheng/wildtoken/internal/localfile"
)

func ConfigPath(tool, scope, custom string) (string, error) {
	if custom != "" {
		return localfile.Expand(custom)
	}
	if scope != "user" && scope != "project" {
		return "", fmt.Errorf("scope must be user or project")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	if tool == "pi" {
		if scope == "project" {
			return "", fmt.Errorf("Pi models.json is user-level; use --config with a separate agent directory")
		}
		root := os.Getenv("PI_CODING_AGENT_DIR")
		if root == "" {
			root = filepath.Join(home, ".pi", "agent")
		}
		return localfile.Expand(filepath.Join(root, "models.json"))
	}
	if tool != "opencode" {
		return "", fmt.Errorf("client must be pi or opencode")
	}
	root := ""
	if scope == "project" {
		root, err = os.Getwd()
		if err != nil {
			return "", err
		}
	} else {
		if custom := os.Getenv("OPENCODE_CONFIG"); custom != "" {
			return localfile.Expand(custom)
		}
		root = os.Getenv("OPENCODE_CONFIG_DIR")
		if root == "" {
			config := os.Getenv("XDG_CONFIG_HOME")
			if config == "" {
				config = filepath.Join(home, ".config")
			}
			root = filepath.Join(config, "opencode")
		}
	}
	jsonPath, jsoncPath := filepath.Join(root, "opencode.json"), filepath.Join(root, "opencode.jsonc")
	exists := func(path string) (bool, error) {
		_, err := os.Lstat(path)
		if os.IsNotExist(err) {
			return false, nil
		}
		return err == nil, err
	}
	j, err := exists(jsonPath)
	if err != nil {
		return "", err
	}
	jc, err := exists(jsoncPath)
	if err != nil {
		return "", err
	}
	if j && jc {
		return "", fmt.Errorf("both opencode.json and opencode.jsonc exist; select one with --config")
	}
	if j {
		return localfile.Expand(jsonPath)
	}
	return localfile.Expand(jsoncPath)
}
