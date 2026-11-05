//go:build windows

package app

// giveToDirOwner has nothing to do on Windows, which has no owner to hand to.
func giveToDirOwner(path, dir string) {}
