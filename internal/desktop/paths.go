// Package desktop owns the desktop launch layout, separate from CLI defaults.
package desktop

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/liguangsheng/wildtoken/internal/config"
)

type paths struct {
	resources string
	data      string
	log       string
}

func bundlePaths(executable, home string) (paths, error) {
	if !filepath.IsAbs(executable) || !filepath.IsAbs(home) {
		return paths{}, errors.New("应用路径和用户目录必须是绝对路径")
	}
	macos := filepath.Dir(executable)
	contents := filepath.Dir(macos)
	if filepath.Base(macos) != "MacOS" || filepath.Base(contents) != "Contents" ||
		!strings.HasSuffix(filepath.Dir(contents), ".app") {
		return paths{}, errors.New("桌面版需要在 WildToken.app 中运行；命令行请使用 CLI 发布包")
	}
	return paths{
		resources: filepath.Join(contents, "Resources"),
		data:      filepath.Join(home, "Library", "Application Support", "WildToken"),
		log:       filepath.Join(home, "Library", "Logs", "WildToken", "wildtoken.log"),
	}, nil
}

func (p paths) prepare() error {
	for _, name := range []string{"config/default.toml", "web/dist/index.html", "static/styles.css"} {
		path := filepath.Join(p.resources, filepath.FromSlash(name))
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() {
			return fmt.Errorf("应用资源缺失：%s", path)
		}
	}
	for _, dir := range []string{p.data, filepath.Join(p.data, "config"), filepath.Dir(p.log)} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("创建用户目录 %s：%w", dir, err)
		}
	}
	return seedConfig(filepath.Join(p.resources, "config", "default.toml"),
		filepath.Join(p.data, "config", "default.toml"))
}

// Link publishes a complete initial config without replacing an existing one.
func seedConfig(source, target string) error {
	if _, err := os.Lstat(target); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	data, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(target), ".initial-config-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(data); err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err := os.Link(file.Name(), target); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	return nil
}

func (p paths) loadSettings() (config.Settings, error) {
	// All relative writable paths, including SQLite URIs and .env overrides,
	// start in this fixed user directory, never in Finder's working directory.
	if err := os.Chdir(p.data); err != nil {
		return config.Settings{}, err
	}
	settings, err := config.Load()
	if err != nil {
		return settings, err
	}
	settings.ResourcesDir = p.resources
	if settings.Themes.Dir == "themes" {
		settings.Themes.Dir = filepath.Join(p.resources, "themes")
	}
	return settings, nil
}

func consoleRequested(args []string, getenv func(string) string) bool {
	for _, arg := range args {
		if arg == "--console" || arg == "--no-tray" || arg == "backup" {
			return true
		}
	}
	for _, key := range []string{"WILDTOKEN_NO_TRAY", "WILDTOKEN_CONSOLE"} {
		switch strings.ToLower(strings.TrimSpace(getenv(key))) {
		case "1", "true", "yes":
			return true
		}
	}
	return false
}
