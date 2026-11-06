package ctl

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/liguangsheng/wildtoken/internal/localfile"
	"github.com/liguangsheng/wildtoken/skills"
)

func runSkill(args []string, o options, stdout io.Writer) error {
	if len(args) != 1 || (args[0] != "show" && args[0] != "install") {
		return errors.New("usage: skill show|install")
	}
	if args[0] == "show" {
		body, err := fs.ReadFile(skills.Files(), "wildtoken/SKILL.md")
		if err != nil {
			return err
		}
		return output(stdout, map[string]string{"name": "wildtoken", "markdown": string(body)}, o)
	}
	if o.apply && !o.yes {
		return errors.New("skill installation requires --apply --yes")
	}
	root := o.config
	if root == "" {
		base := ""
		var err error
		switch o.scope {
		case "user":
			base, err = os.UserHomeDir()
		case "project":
			base, err = os.Getwd()
		default:
			return errors.New("scope must be user or project")
		}
		if err != nil {
			return err
		}
		root = filepath.Join(base, ".agents", "skills", "wildtoken")
	}
	root, err := localfile.Expand(root)
	if err != nil {
		return err
	}
	if filepath.Base(root) != "wildtoken" {
		return errors.New("skill directory must be named wildtoken")
	}
	type change struct {
		snapshot localfile.Snapshot
		data     []byte
	}
	var changes []change
	targets := []string{}
	err = fs.WalkDir(skills.Files(), "wildtoken", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		data, err := fs.ReadFile(skills.Files(), path)
		if err != nil {
			return err
		}
		target := filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(path, "wildtoken/")))
		snapshot, err := localfile.Read(target)
		if err != nil {
			return err
		}
		if snapshot.Exists() && bytes.Equal(data, snapshot.Data) {
			return nil
		}
		if snapshot.Exists() && !o.replace {
			return fmt.Errorf("skill file already exists: %s; inspect before using --replace", target)
		}
		changes = append(changes, change{snapshot, data})
		targets = append(targets, target)
		return nil
	})
	if err != nil {
		return err
	}
	backups := []string{}
	if o.apply {
		for i, change := range changes {
			backup, err := change.snapshot.Apply(change.data)
			if err != nil {
				return fmt.Errorf("skill installation stopped after %d files; retained backups %v: %w", i, backups, err)
			}
			if backup != "" {
				backups = append(backups, backup)
			}
		}
	}
	return output(stdout, map[string]any{"skill": "wildtoken", "directory": root, "files": targets,
		"applied": o.apply, "backups": backups}, o)
}
