package ctl

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestCommandCatalogCoversEveryAdminRoute(t *testing.T) {
	file, err := parser.ParseFile(token.NewFileSet(), filepath.Join("..", "app", "router.go"), nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	prefixes := map[string]string{"router": ""}
	catalog := map[string]bool{}
	for _, command := range commands {
		catalog[command.Method+" "+strings.TrimRight(command.Path, "/")] = true
	}
	seen := 0
	ast.Inspect(file, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		receiver, ok := selector.X.(*ast.Ident)
		if !ok || len(call.Args) < 2 {
			return true
		}
		base, known := prefixes[receiver.Name]
		if !known {
			return true
		}
		literal, ok := call.Args[0].(*ast.BasicLit)
		if !ok || literal.Kind != token.STRING {
			return true
		}
		path, err := strconv.Unquote(literal.Value)
		if err != nil {
			t.Fatal(err)
		}
		if selector.Sel.Name == "Route" {
			fn, ok := call.Args[1].(*ast.FuncLit)
			if ok && len(fn.Type.Params.List) > 0 {
				for _, name := range fn.Type.Params.List[0].Names {
					prefixes[name.Name] = base + path
				}
			}
			return true
		}
		method := strings.ToUpper(selector.Sel.Name)
		if method != "GET" && method != "POST" && method != "PUT" && method != "PATCH" && method != "DELETE" {
			return true
		}
		full := strings.TrimRight(base+path, "/")
		if !strings.HasPrefix(full, "/api/admin/") {
			return true
		}
		seen++
		if !catalog[method+" "+full] {
			t.Errorf("CLI does not cover %s %s", method, full)
		}
		return true
	})
	if seen < 40 {
		t.Fatalf("route scanner saw only %d endpoints", seen)
	}
}

func TestCommandArgumentsCannotChangeTheURLStructure(t *testing.T) {
	for _, args := range [][]string{
		{"tokens", "get", "../settings"}, {"upstreams", "get", "0"}, {"logs", "snapshot", "1", "../settings"},
		{"logs", "get"}, {"status", "unexpected"},
	} {
		if _, _, err := resolveCommand(args); err == nil {
			t.Errorf("accepted invalid command: %v", args)
		}
	}
}
