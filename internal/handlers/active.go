package handlers

import (
	"net"
	"net/http"
	"net/netip"

	"github.com/liguangsheng/wildtoken/internal/apperr"
	"github.com/liguangsheng/wildtoken/internal/appstate"
)

// ActiveCount answers how many requests are being proxied, so a deploy can wait
// for a quiet moment before it swaps the container.
//
// Only a caller on this machine gets an answer — the deploy asks from inside
// the container — and anyone else a 404. A reverse proxy on the same host
// passes for local; what leaks through it is one number.
func ActiveCount(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !fromLoopback(r) {
			http.NotFound(w, r)
			return
		}
		apperr.WriteJSON(w, http.StatusOK, map[string]int{"active": state.ActiveRequests.Len()})
	}
}

// fromLoopback reports whether the connection itself comes from this machine.
// Forwarding headers are ignored: any caller can write them.
func fromLoopback(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	addr, err := netip.ParseAddr(host)
	return err == nil && addr.Unmap().IsLoopback()
}
