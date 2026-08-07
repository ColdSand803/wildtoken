//! Admission control for admin authentication.
//!
//! Every miss on the verified-token cache costs an Argon2id verification: tens
//! of milliseconds of CPU and ~19 MiB of memory, spent before the caller has
//! proven anything. Guessing a high-entropy token that way is hopeless, but
//! keeping the console busy is not — a steady stream of wrong tokens is enough.
//!
//! Three limits apply, cheapest first: a per-client backoff, a global failure
//! gate for callers that rotate addresses, and a bound on how many requests may
//! queue for the verification slot. Loopback callers skip the first two; the
//! machine is already trusted, and locking the operator out of their own
//! console is the failure mode worth avoiding most.

use std::{
    collections::HashMap,
    net::IpAddr,
    time::{Duration, Instant},
};

use tokio::sync::Mutex;

/// Failures a client may accumulate before backoff starts.
const FREE_ATTEMPTS: u32 = 5;
/// First backoff step, doubled per failure beyond [`FREE_ATTEMPTS`].
const BASE_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// Idle period after which a client's failure streak is forgotten.
const CLIENT_RESET_AFTER: Duration = Duration::from_secs(15 * 60);
/// Cap on tracked clients, so address rotation cannot grow the map without end.
const MAX_TRACKED_CLIENTS: usize = 4096;

const GLOBAL_WINDOW: Duration = Duration::from_secs(60);
/// Failures per [`GLOBAL_WINDOW`] before every non-loopback caller is refused.
const GLOBAL_THRESHOLD: u32 = 100;
const GLOBAL_COOLDOWN: Duration = Duration::from_secs(30);

/// Requests allowed to queue for the verification slot. Beyond this the queue
/// itself becomes the amplifier, so surplus callers are refused outright.
const MAX_VERIFICATION_WAITERS: usize = 8;

/// Who is asking. `Unknown` covers requests whose peer address the server could
/// not determine; they are subject to the global gate but cannot be tracked
/// individually.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdminClient {
    Loopback,
    Remote(IpAddr),
    Unknown,
}

impl AdminClient {
    pub fn from_ip(ip: IpAddr) -> Self {
        if ip.is_loopback() {
            Self::Loopback
        } else {
            Self::Remote(ip)
        }
    }

    fn exempt(self) -> bool {
        matches!(self, Self::Loopback)
    }

    fn key(self) -> Option<IpAddr> {
        match self {
            Self::Remote(ip) => Some(ip),
            _ => None,
        }
    }
}

#[derive(Debug)]
struct ClientState {
    failures: u32,
    blocked_until: Option<Instant>,
    last_failure: Instant,
}

#[derive(Debug)]
struct GlobalState {
    window_start: Instant,
    failures: u32,
    cooldown_until: Option<Instant>,
}

pub struct AdminAuthThrottle {
    clients: Mutex<HashMap<IpAddr, ClientState>>,
    global: Mutex<GlobalState>,
}

impl AdminAuthThrottle {
    pub fn new() -> Self {
        Self {
            clients: Mutex::new(HashMap::new()),
            global: Mutex::new(GlobalState {
                window_start: Instant::now(),
                failures: 0,
                cooldown_until: None,
            }),
        }
    }

    /// Whether `client` may pay for an Argon2id verification right now.
    pub async fn admit(&self, client: AdminClient) -> bool {
        if client.exempt() {
            return true;
        }
        let now = Instant::now();

        {
            let mut global = self.global.lock().await;
            if global.cooldown_until.is_some_and(|deadline| now < deadline) {
                return false;
            }
            global.cooldown_until = None;
        }

        let Some(ip) = client.key() else {
            return true;
        };
        let clients = self.clients.lock().await;
        clients
            .get(&ip)
            .and_then(|state| state.blocked_until)
            .is_none_or(|deadline| now >= deadline)
    }

    /// Clear a client's failure streak. Called only after a real Argon2id
    /// verification succeeds, so a valid token always buys its way back in.
    pub async fn record_success(&self, client: AdminClient) {
        if let Some(ip) = client.key() {
            self.clients.lock().await.remove(&ip);
        }
    }

    pub async fn record_failure(&self, client: AdminClient) {
        if client.exempt() {
            return;
        }
        let now = Instant::now();

        {
            let mut global = self.global.lock().await;
            if now.duration_since(global.window_start) >= GLOBAL_WINDOW {
                global.window_start = now;
                global.failures = 0;
            }
            global.failures += 1;
            if global.failures >= GLOBAL_THRESHOLD {
                global.cooldown_until = Some(now + GLOBAL_COOLDOWN);
                global.window_start = now;
                global.failures = 0;
            }
        }

        let Some(ip) = client.key() else {
            return;
        };
        let mut clients = self.clients.lock().await;
        prune(&mut clients, now);
        let state = clients.entry(ip).or_insert(ClientState {
            failures: 0,
            blocked_until: None,
            last_failure: now,
        });
        state.failures = state.failures.saturating_add(1);
        state.last_failure = now;
        state.blocked_until = backoff(state.failures).map(|delay| now + delay);
    }
}

impl Default for AdminAuthThrottle {
    fn default() -> Self {
        Self::new()
    }
}

/// Backoff for the `failures`-th consecutive failure, or `None` while the
/// client is still within its free attempts.
fn backoff(failures: u32) -> Option<Duration> {
    let penalized = failures.checked_sub(FREE_ATTEMPTS)?;
    if penalized == 0 {
        return None;
    }
    let exponent = (penalized - 1).min(u32::BITS - 1);
    let delay = BASE_BACKOFF
        .checked_mul(1_u32.checked_shl(exponent).unwrap_or(u32::MAX))
        .unwrap_or(MAX_BACKOFF);
    Some(delay.min(MAX_BACKOFF))
}

/// Drop entries that have gone quiet. If the map is still full afterwards the
/// traffic is distributed rather than repetitive, and the global gate is the
/// limit that applies; refuse to grow further rather than track it all.
fn prune(clients: &mut HashMap<IpAddr, ClientState>, now: Instant) {
    if clients.len() < MAX_TRACKED_CLIENTS {
        return;
    }
    clients.retain(|_, state| {
        now.duration_since(state.last_failure) < CLIENT_RESET_AFTER
            || state.blocked_until.is_some_and(|deadline| now < deadline)
    });
    if clients.len() >= MAX_TRACKED_CLIENTS {
        clients.clear();
    }
}

/// Bounds the queue for the single verification slot.
pub(crate) struct VerificationQueue {
    waiting: std::sync::atomic::AtomicUsize,
    slot: Mutex<()>,
}

impl VerificationQueue {
    pub(crate) fn new() -> Self {
        Self {
            waiting: std::sync::atomic::AtomicUsize::new(0),
            slot: Mutex::new(()),
        }
    }

    /// Wait for the verification slot, or return `None` if too many requests
    /// are already queued for it.
    pub(crate) async fn enter(&self) -> Option<tokio::sync::MutexGuard<'_, ()>> {
        use std::sync::atomic::Ordering;

        let queued = self
            .waiting
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                (current < MAX_VERIFICATION_WAITERS).then_some(current + 1)
            });
        if queued.is_err() {
            return None;
        }
        let guard = self.slot.lock().await;
        self.waiting.fetch_sub(1, Ordering::AcqRel);
        Some(guard)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_attempts_are_unpenalized_then_backoff_doubles_to_a_cap() {
        for failures in 0..=FREE_ATTEMPTS {
            assert_eq!(backoff(failures), None, "failure #{failures}");
        }
        assert_eq!(backoff(FREE_ATTEMPTS + 1), Some(BASE_BACKOFF));
        assert_eq!(backoff(FREE_ATTEMPTS + 2), Some(BASE_BACKOFF * 2));
        assert_eq!(backoff(FREE_ATTEMPTS + 3), Some(BASE_BACKOFF * 4));
        assert_eq!(backoff(u32::MAX), Some(MAX_BACKOFF));
    }

    #[tokio::test]
    async fn loopback_is_never_throttled() {
        let throttle = AdminAuthThrottle::new();
        for _ in 0..(GLOBAL_THRESHOLD * 2) {
            throttle.record_failure(AdminClient::Loopback).await;
        }
        assert!(throttle.admit(AdminClient::Loopback).await);
    }

    #[tokio::test]
    async fn a_client_is_blocked_only_after_its_free_attempts() {
        let throttle = AdminAuthThrottle::new();
        let client = AdminClient::from_ip("203.0.113.7".parse().unwrap());

        for _ in 0..FREE_ATTEMPTS {
            assert!(throttle.admit(client).await);
            throttle.record_failure(client).await;
        }
        assert!(throttle.admit(client).await);
        throttle.record_failure(client).await;
        assert!(!throttle.admit(client).await);
    }

    #[tokio::test]
    async fn success_clears_the_failure_streak() {
        let throttle = AdminAuthThrottle::new();
        let client = AdminClient::from_ip("203.0.113.8".parse().unwrap());

        for _ in 0..(FREE_ATTEMPTS + 1) {
            throttle.record_failure(client).await;
        }
        assert!(!throttle.admit(client).await);

        throttle.record_success(client).await;
        assert!(throttle.admit(client).await);
    }

    #[tokio::test]
    async fn one_client_cannot_block_another_until_the_global_gate_trips() {
        let throttle = AdminAuthThrottle::new();
        let noisy = AdminClient::from_ip("203.0.113.9".parse().unwrap());
        let quiet = AdminClient::from_ip("198.51.100.4".parse().unwrap());

        for _ in 0..(FREE_ATTEMPTS + 1) {
            throttle.record_failure(noisy).await;
        }
        assert!(!throttle.admit(noisy).await);
        assert!(throttle.admit(quiet).await);

        for _ in 0..GLOBAL_THRESHOLD {
            throttle.record_failure(noisy).await;
        }
        assert!(!throttle.admit(quiet).await);
        assert!(throttle.admit(AdminClient::Loopback).await);
    }

    #[tokio::test]
    async fn rotating_addresses_cannot_grow_the_client_map_without_end() {
        let throttle = AdminAuthThrottle::new();
        for index in 0..(MAX_TRACKED_CLIENTS + 64) {
            let ip = IpAddr::from(std::net::Ipv6Addr::from(index as u128 + 1));
            throttle.record_failure(AdminClient::from_ip(ip)).await;
        }
        assert!(throttle.clients.lock().await.len() <= MAX_TRACKED_CLIENTS);
    }

    #[tokio::test]
    async fn the_verification_queue_refuses_surplus_waiters() {
        let queue = std::sync::Arc::new(VerificationQueue::new());
        let held = queue.enter().await.expect("first caller takes the slot");

        let mut waiters = Vec::new();
        for _ in 0..MAX_VERIFICATION_WAITERS {
            let queue = std::sync::Arc::clone(&queue);
            waiters.push(tokio::spawn(async move { queue.enter().await.is_some() }));
        }
        // Let every spawned waiter reach the queue before testing the overflow.
        while queue.waiting.load(std::sync::atomic::Ordering::Acquire) < MAX_VERIFICATION_WAITERS {
            tokio::task::yield_now().await;
        }

        assert!(queue.enter().await.is_none());

        drop(held);
        for waiter in waiters {
            assert!(waiter.await.unwrap());
        }
        assert!(queue.enter().await.is_some());
    }
}
