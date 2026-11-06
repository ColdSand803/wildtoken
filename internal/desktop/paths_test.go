package desktop

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func desktopFixture(t *testing.T) paths {
	t.Helper()
	root := t.TempDir()
	p, err := bundlePaths(filepath.Join(root, "App Folder", "WildToken.app", "Contents", "MacOS", "wildtoken"),
		filepath.Join(root, "User Home"))
	if err != nil {
		t.Fatal(err)
	}
	for name, value := range map[string]string{
		"config/default.toml": "[server]\nport = 3100\n",
		"web/dist/index.html": "<title>WildToken Console</title>",
		"static/styles.css":   "body{}",
	} {
		writeFixture(t, filepath.Join(p.resources, filepath.FromSlash(name)), value)
	}
	return p
}

func writeFixture(t *testing.T, path, value string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(value), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestBundleLayoutSeparatesResourcesAndUserData(t *testing.T) {
	p := desktopFixture(t)
	if !strings.HasSuffix(p.resources, filepath.FromSlash("WildToken.app/Contents/Resources")) ||
		!strings.HasSuffix(p.data, filepath.FromSlash("Library/Application Support/WildToken")) ||
		!strings.HasSuffix(p.log, filepath.FromSlash("Library/Logs/WildToken/wildtoken.log")) {
		t.Fatalf("unexpected layout: %+v", p)
	}
	if err := p.prepare(); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(p.data, "config", "default.toml")
	before, err := os.ReadFile(config)
	if err != nil || len(before) == 0 {
		t.Fatalf("seed config: %q %v", before, err)
	}
	writeFixture(t, config, "# operator-owned\n[server]\nport = 3200\n")
	writeFixture(t, filepath.Join(p.data, "wildtoken.db"), "existing database")
	writeFixture(t, filepath.Join(p.resources, "config", "default.toml"), "# new application defaults\n")
	if err := p.prepare(); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(config)
	if string(after) != "# operator-owned\n[server]\nport = 3200\n" {
		t.Fatalf("upgrade replaced config: %q", after)
	}
	data, _ := os.ReadFile(filepath.Join(p.data, "wildtoken.db"))
	if string(data) != "existing database" {
		t.Fatal("prepare changed the database")
	}
	if _, err := os.Stat(filepath.Join(p.resources, "wildtoken.db")); !os.IsNotExist(err) {
		t.Fatal("database was placed in the application bundle")
	}
}

func TestIncompleteOrUnbundledDesktopLaunchIsRefused(t *testing.T) {
	if _, err := bundlePaths(filepath.Join(t.TempDir(), "wildtoken"), t.TempDir()); err == nil {
		t.Fatal("an unbundled executable was accepted")
	}
	p := desktopFixture(t)
	if err := os.Remove(filepath.Join(p.resources, "web", "dist", "index.html")); err != nil {
		t.Fatal(err)
	}
	if err := p.prepare(); err == nil {
		t.Fatal("missing console resources were accepted")
	}
	if _, err := os.Stat(p.data); !os.IsNotExist(err) {
		t.Fatal("an incomplete bundle wrote user data")
	}
}

func TestInitialConfigPublicationDoesNotRaceOrTruncate(t *testing.T) {
	dir := t.TempDir()
	source, target := filepath.Join(dir, "source.toml"), filepath.Join(dir, "config.toml")
	want := strings.Repeat("# configuration\n", 100)
	writeFixture(t, source, want)
	var group sync.WaitGroup
	for range 12 {
		group.Go(func() {
			if err := seedConfig(source, target); err != nil {
				t.Error(err)
			}
		})
	}
	group.Wait()
	got, err := os.ReadFile(target)
	if err != nil || string(got) != want {
		t.Fatalf("published config incomplete: %v", err)
	}
	leftovers, _ := filepath.Glob(filepath.Join(dir, ".initial-config-*"))
	if len(leftovers) != 0 {
		t.Fatalf("temporary configs remain: %v", leftovers)
	}
}

func TestDesktopConfigReadsTheUserDirectoryAndEnvironment(t *testing.T) {
	p := desktopFixture(t)
	if err := p.prepare(); err != nil {
		t.Fatal(err)
	}
	// Register cwd restoration before the launch changes it.
	t.Chdir(t.TempDir())
	writeFixture(t, ".env", "ADMIN_TOKEN=wrong-working-directory\n")
	writeFixture(t, filepath.Join(p.data, "config", "development.toml"), "[server]\nport = 3200\n")
	writeFixture(t, filepath.Join(p.data, ".env"), "ADMIN_TOKEN=user-directory-token\nAPP__SERVER__PORT=3300\n")
	t.Setenv("RUN_ENV", "development")
	t.Setenv("APP__SERVER__PORT", "3400")
	t.Setenv("ADMIN_TOKEN", "")
	os.Unsetenv("ADMIN_TOKEN")
	settings, err := p.loadSettings()
	if err != nil {
		t.Fatal(err)
	}
	cwd, _ := os.Getwd()
	resolvedData, _ := filepath.EvalSymlinks(p.data)
	resolvedCWD, _ := filepath.EvalSymlinks(cwd)
	if resolvedCWD != resolvedData || settings.Server.Port != 3400 || settings.Admin.Token != "user-directory-token" {
		t.Fatalf("cwd=%q settings=%+v", cwd, settings.Server)
	}
	if settings.ResourcePath("web", "dist", "index.html") != filepath.Join(p.resources, "web", "dist", "index.html") ||
		settings.Themes.Dir != filepath.Join(p.resources, "themes") {
		t.Fatalf("resources are not bundle-relative: %+v", settings)
	}
	if settings.Database.URL != "sqlite:wildtoken.db?mode=rwc" {
		t.Fatalf("default database changed: %s", settings.Database.URL)
	}
}

func TestDesktopConsoleModesDoNotStartTheMenu(t *testing.T) {
	for _, args := range [][]string{{"--console"}, {"--no-tray"}, {"backup"}} {
		if !consoleRequested(args, func(string) string { return "" }) {
			t.Errorf("console mode ignored: %v", args)
		}
	}
	for _, value := range []string{"1", "TRUE", " yes "} {
		if !consoleRequested(nil, func(string) string { return value }) {
			t.Errorf("console environment ignored: %q", value)
		}
	}
	if consoleRequested(nil, func(string) string { return "0" }) {
		t.Error("ordinary desktop launch chose console mode")
	}
}
