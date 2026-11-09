//go:build !darwin || !desktop

package main

func desktopMain() (bool, int) { return false, 0 }
