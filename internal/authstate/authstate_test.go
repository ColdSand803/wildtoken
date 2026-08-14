package authstate

import (
	"net/netip"
	"sync"
	"testing"
	"time"

	"github.com/liguangsheng/wildtoken/internal/models"
)

// These fixtures were produced by the Rust `argon2` crate v0.5.3 with
// `Argon2::default()`, the exact configuration the previous implementation
// used. They are what proves an operator upgrading from the Rust build can
// still sign in with their existing database.
const (
	rustHashStrongToken = "$argon2id$v=19$m=19456,t=2,p=1$MWM39sxqr7JgfYYAAWFYHg$csDRV3g35qzySidcgTxSmpnUQKnYE0dOk2yBpQ53030"
	rustStrongToken     = "strong-admin-token-for-tests"

	rustHashChangeMe = "$argon2id$v=19$m=19456,t=2,p=1$qlgYnFza3O2mZ3sEFaoEVQ$DHJbHg0hfLKVpUjNeOT0wSr5Qrv48Ets9aWf5ONeWME"
	rustChangeMe     = "change-me"
)

func TestVerifiesHashesProducedByTheRustImplementation(t *testing.T) {
	for _, fixture := range []struct{ hash, token string }{
		{rustHashStrongToken, rustStrongToken},
		{rustHashChangeMe, rustChangeMe},
	} {
		credential := models.AdminCredential{CredentialHash: fixture.hash, CredentialVersion: 1}
		if !VerifyAdminToken(credential, fixture.token) {
			t.Errorf("a Rust-produced hash did not verify for %q", fixture.token)
		}
		if VerifyAdminToken(credential, fixture.token+"x") {
			t.Errorf("a wrong token verified against the hash for %q", fixture.token)
		}
	}

	// The two fixtures must not verify against each other's token.
	crossed := models.AdminCredential{CredentialHash: rustHashStrongToken, CredentialVersion: 1}
	if VerifyAdminToken(crossed, rustChangeMe) {
		t.Error("a hash verified against an unrelated token")
	}
}

func TestOurOwnHashesUseTheSameParametersAndRoundTrip(t *testing.T) {
	hash, err := HashAdminToken(rustStrongToken)
	if err != nil {
		t.Fatalf("hash: %v", err)
	}

	memory, timeCost, threads, salt, key, err := parsePHC(hash)
	if err != nil {
		t.Fatalf("parse our own hash: %v", err)
	}
	if memory != argonMemoryKiB || timeCost != argonTime || threads != argonThreads {
		t.Errorf("parameters m=%d,t=%d,p=%d, want m=%d,t=%d,p=%d",
			memory, timeCost, threads, argonMemoryKiB, argonTime, argonThreads)
	}
	if len(salt) != argonSaltLen || len(key) != int(argonKeyLen) {
		t.Errorf("salt=%d bytes key=%d bytes, want %d and %d",
			len(salt), len(key), argonSaltLen, argonKeyLen)
	}

	// Our parameters match the Rust defaults, so a fixture parses identically.
	rustMemory, rustTime, rustThreads, _, _, err := parsePHC(rustHashStrongToken)
	if err != nil {
		t.Fatalf("parse the Rust fixture: %v", err)
	}
	if rustMemory != memory || rustTime != timeCost || rustThreads != threads {
		t.Errorf("our parameters drifted from the Rust defaults: got m=%d,t=%d,p=%d want m=%d,t=%d,p=%d",
			memory, timeCost, threads, rustMemory, rustTime, rustThreads)
	}

	credential := models.AdminCredential{CredentialHash: hash, CredentialVersion: 1}
	if !VerifyAdminToken(credential, rustStrongToken) {
		t.Error("our own hash did not verify")
	}

	// A second hash of the same token differs, because the salt is random.
	other, err := HashAdminToken(rustStrongToken)
	if err != nil {
		t.Fatalf("second hash: %v", err)
	}
	if other == hash {
		t.Error("two hashes of the same token were identical; the salt is not random")
	}
}

func TestMalformedHashesAreRejectedRatherThanPanicking(t *testing.T) {
	for _, encoded := range []string{
		"",
		"not-a-phc-string",
		"$argon2id$v=19$m=19456,t=2,p=1$onlyfourfields",
		// A different algorithm must not be silently accepted as argon2id.
		"$argon2i$v=19$m=19456,t=2,p=1$MWM39sxqr7JgfYYAAWFYHg$csDRV3g35qzySidcgTxSmpnUQKnYE0dOk2yBpQ53030",
		// An unsupported version.
		"$argon2id$v=16$m=19456,t=2,p=1$MWM39sxqr7JgfYYAAWFYHg$csDRV3g35qzySidcgTxSmpnUQKnYE0dOk2yBpQ53030",
		// Invalid base64 in the salt.
		"$argon2id$v=19$m=19456,t=2,p=1$!!!!$csDRV3g35qzySidcgTxSmpnUQKnYE0dOk2yBpQ53030",
		// An empty hash segment.
		"$argon2id$v=19$m=19456,t=2,p=1$MWM39sxqr7JgfYYAAWFYHg$",
	} {
		credential := models.AdminCredential{CredentialHash: encoded, CredentialVersion: 1}
		if VerifyAdminToken(credential, rustStrongToken) {
			t.Errorf("malformed hash %q was accepted", encoded)
		}
	}
}

func remoteClient(t *testing.T, address string) Client {
	t.Helper()
	addr, err := netip.ParseAddr(address)
	if err != nil {
		t.Fatalf("parse %s: %v", address, err)
	}
	return ClientFromAddr(addr)
}

func TestFreeAttemptsAreUnpenalizedThenBackoffDoublesToACap(t *testing.T) {
	for failures := uint32(0); failures <= freeAttempts; failures++ {
		if _, penalized := backoff(failures); penalized {
			t.Errorf("failure #%d was penalized within the free attempts", failures)
		}
	}
	for _, testCase := range []struct {
		failures uint32
		want     time.Duration
	}{
		{freeAttempts + 1, baseBackoff},
		{freeAttempts + 2, baseBackoff * 2},
		{freeAttempts + 3, baseBackoff * 4},
		{^uint32(0), maxBackoff},
	} {
		delay, penalized := backoff(testCase.failures)
		if !penalized || delay != testCase.want {
			t.Errorf("backoff(%d) = %v (penalized=%v), want %v",
				testCase.failures, delay, penalized, testCase.want)
		}
	}
}

func TestLoopbackKeepsItsFreeAttemptsButNotAFreePass(t *testing.T) {
	throttle := NewThrottle()
	loopback := Client{Kind: ClientLoopback}

	// An operator mistyping the token is not penalised for it: loopback has no
	// address to track, so there is no per-client backoff to serve.
	for range freeAttempts {
		throttle.RecordFailure(loopback)
		if !throttle.Admit(loopback) {
			t.Fatal("a loopback caller was blocked within its free attempts")
		}
	}

	// A flood is another matter. Behind a same-host reverse proxy every caller
	// in the world arrives as loopback, so exempting it from the gate left
	// nothing but Argon2id's own cost bounding a guessing run.
	for range globalThreshold {
		throttle.RecordFailure(loopback)
	}
	if throttle.Admit(loopback) {
		t.Error("the gate did not refuse a loopback caller after a flood of failures")
	}
}

func TestARemoteFloodCannotLockOutTheLocalOperator(t *testing.T) {
	throttle := NewThrottle()
	noisy := remoteClient(t, "203.0.113.9")

	for range globalThreshold {
		throttle.RecordFailure(noisy)
	}

	// The gates are counted separately for exactly this: the console must stay
	// reachable from the machine it runs on while it is under attack.
	if !throttle.Admit(Client{Kind: ClientLoopback}) {
		t.Error("a remote flood locked the local operator out")
	}
}

func TestAClientIsBlockedOnlyAfterItsFreeAttempts(t *testing.T) {
	throttle := NewThrottle()
	client := remoteClient(t, "203.0.113.7")

	for range freeAttempts {
		if !throttle.Admit(client) {
			t.Fatal("a client was blocked within its free attempts")
		}
		throttle.RecordFailure(client)
	}
	if !throttle.Admit(client) {
		t.Fatal("the last free attempt was refused")
	}
	throttle.RecordFailure(client)
	if throttle.Admit(client) {
		t.Error("the client was admitted past its free attempts")
	}
}

func TestSuccessClearsTheFailureStreak(t *testing.T) {
	throttle := NewThrottle()
	client := remoteClient(t, "203.0.113.8")

	for range freeAttempts + 1 {
		throttle.RecordFailure(client)
	}
	if throttle.Admit(client) {
		t.Fatal("the client was not blocked after exhausting its free attempts")
	}

	throttle.RecordSuccess(client)
	if !throttle.Admit(client) {
		t.Error("a valid token did not buy the client back in")
	}
}

func TestOneClientCannotBlockAnotherUntilTheGlobalGateTrips(t *testing.T) {
	throttle := NewThrottle()
	noisy := remoteClient(t, "203.0.113.9")
	quiet := remoteClient(t, "198.51.100.4")

	for range freeAttempts + 1 {
		throttle.RecordFailure(noisy)
	}
	if throttle.Admit(noisy) {
		t.Fatal("the noisy client was not blocked")
	}
	if !throttle.Admit(quiet) {
		t.Fatal("a quiet client was blocked by its peer's failures")
	}

	for range globalThreshold {
		throttle.RecordFailure(noisy)
	}
	if throttle.Admit(quiet) {
		t.Error("the global gate did not refuse a quiet remote caller")
	}
	if !throttle.Admit(Client{Kind: ClientLoopback}) {
		t.Error("the global gate locked out the local operator")
	}
}

func TestRotatingAddressesCannotGrowTheClientMapWithoutEnd(t *testing.T) {
	throttle := NewThrottle()
	for index := range maxTrackedClients + 64 {
		addr := netip.AddrFrom16([16]byte{
			byte(index >> 24), byte(index >> 16), byte(index >> 8), byte(index),
			0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
		})
		throttle.RecordFailure(ClientFromAddr(addr))
	}
	if tracked := throttle.trackedClients(); tracked > maxTrackedClients {
		t.Errorf("tracked %d clients, want at most %d", tracked, maxTrackedClients)
	}
}

func TestTheVerificationQueueRefusesSurplusWaiters(t *testing.T) {
	queue := newVerificationQueue()
	release, admitted := queue.enter()
	if !admitted {
		t.Fatal("the first caller did not take the slot")
	}

	var waiters sync.WaitGroup
	results := make([]bool, maxVerificationWaiters)
	for i := range maxVerificationWaiters {
		waiters.Add(1)
		go func() {
			defer waiters.Done()
			waiterRelease, ok := queue.enter()
			results[i] = ok
			if ok {
				waiterRelease()
			}
		}()
	}

	// Let every goroutine reach the queue before testing the overflow.
	deadline := time.Now().Add(5 * time.Second)
	for queue.waitingCount() < maxVerificationWaiters {
		if time.Now().After(deadline) {
			t.Fatal("the waiters never filled the queue")
		}
		time.Sleep(time.Millisecond)
	}

	if _, ok := queue.enter(); ok {
		t.Error("a surplus waiter was admitted")
	}

	release()
	waiters.Wait()
	for i, ok := range results {
		if !ok {
			t.Errorf("queued waiter %d was refused", i)
		}
	}

	finalRelease, ok := queue.enter()
	if !ok {
		t.Fatal("the slot was not released")
	}
	finalRelease()
}

func TestAuthenticationCachesAVerifiedTokenAndInvalidatesOnRotation(t *testing.T) {
	hash, err := HashAdminToken(rustStrongToken)
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	throttle := NewThrottle()
	credentials, err := NewCredentials(
		models.AdminCredential{CredentialHash: hash, CredentialVersion: 1}, throttle)
	if err != nil {
		t.Fatalf("new credentials: %v", err)
	}
	client := Client{Kind: ClientLoopback}

	version, ok := credentials.Authenticate(rustStrongToken, client)
	if !ok || version != 1 {
		t.Fatalf("first authentication = (%d, %v), want (1, true)", version, ok)
	}
	if verifications := credentials.cache.argon2Verifications.Load(); verifications != 1 {
		t.Fatalf("first authentication ran %d verifications, want 1", verifications)
	}

	// Repeat traffic is answered from the cache, without paying for Argon2id.
	for range 10 {
		if _, ok := credentials.Authenticate(rustStrongToken, client); !ok {
			t.Fatal("a cached token was refused")
		}
	}
	if verifications := credentials.cache.argon2Verifications.Load(); verifications != 1 {
		t.Errorf("cached authentications ran %d verifications, want 1", verifications)
	}

	// A rotation clears the cache, so the old token stops working immediately.
	rotatedHash, err := HashAdminToken("a-different-admin-token-value")
	if err != nil {
		t.Fatalf("rotate hash: %v", err)
	}
	credentials.Publish(models.AdminCredential{CredentialHash: rotatedHash, CredentialVersion: 2})

	if _, ok := credentials.Authenticate(rustStrongToken, client); ok {
		t.Error("the pre-rotation token still authenticated")
	}
	if version, ok := credentials.Authenticate("a-different-admin-token-value", client); !ok || version != 2 {
		t.Errorf("post-rotation authentication = (%d, %v), want (2, true)", version, ok)
	}
}

func TestPublishIgnoresAnOlderCredentialSnapshot(t *testing.T) {
	hash, err := HashAdminToken(rustStrongToken)
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	credentials, err := NewCredentials(
		models.AdminCredential{CredentialHash: hash, CredentialVersion: 5}, NewThrottle())
	if err != nil {
		t.Fatalf("new credentials: %v", err)
	}

	credentials.Publish(models.AdminCredential{CredentialHash: "stale", CredentialVersion: 3})
	if version := credentials.Version(); version != 5 {
		t.Errorf("version = %d, want the generation to never move backwards", version)
	}
	if snapshot := credentials.Snapshot(); snapshot.CredentialHash != hash {
		t.Error("an older snapshot overwrote the current credential")
	}
}

func TestThrottledClientsNeverReachVerification(t *testing.T) {
	hash, err := HashAdminToken(rustStrongToken)
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	throttle := NewThrottle()
	credentials, err := NewCredentials(
		models.AdminCredential{CredentialHash: hash, CredentialVersion: 1}, throttle)
	if err != nil {
		t.Fatalf("new credentials: %v", err)
	}
	client := remoteClient(t, "203.0.113.20")

	for range freeAttempts + 1 {
		if _, ok := credentials.Authenticate("wrong-token", client); ok {
			t.Fatal("a wrong token authenticated")
		}
	}
	blockedAt := credentials.cache.argon2Verifications.Load()

	// Once blocked, further attempts must not cost an Argon2id verification.
	for range 5 {
		if _, ok := credentials.Authenticate("wrong-token", client); ok {
			t.Fatal("a blocked client authenticated")
		}
	}
	if after := credentials.cache.argon2Verifications.Load(); after != blockedAt {
		t.Errorf("a blocked client paid for %d verifications", after-blockedAt)
	}

	// The correct token is refused too while the backoff is in force.
	if _, ok := credentials.Authenticate(rustStrongToken, client); ok {
		t.Error("a blocked client bypassed the backoff with a valid token")
	}
}
