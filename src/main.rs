mod config;
mod db;
mod error;
mod handlers;
mod middleware;
mod models;
mod proxy;
mod state;

use std::sync::Arc;
use axum::{routing::{get, post, patch, any}, Router};
use tower_http::cors::{CorsLayer, Any, AllowOrigin};
use tower_http::trace::TraceLayer;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use crate::proxy::matcher::BackoffManager;
use crate::state::{AppState, init_db, seed_default_token};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 1. Initialize tracing
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into()),
        ))
        .with(tracing_subscriber::fmt::layer())
        .init();

    // 2. Load config
    let settings = config::Settings::load().expect("Failed to load configuration");
    let bind_addr = format!("{}:{}", settings.server.host, settings.server.port);
    let database_url = settings.database.url.clone();

    // 3. Setup database
    let db = sqlx::SqlitePool::connect(&database_url).await?;
    init_db(&db).await?;
    seed_default_token(&db, &settings).await?;

    // 4. Setup HTTP client
    let http_client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(settings.upstream.default_timeout_seconds as u64))
        .pool_max_idle_per_host(20)
        .build()?;

    // 5. Create shared state
    let state = AppState {
        db: db.clone(),
        http_client,
        settings: settings.clone(),
        backoff: Arc::new(BackoffManager::new()),
    };

    // 6. Spawn background cleanup
    tokio::spawn(proxy::logging::cleanup_loop(db.clone()));

    // 7. Build router

    // ── Admin API ───────────────────────────────────────────────────────
    let admin_routes = Router::new()
        // Upstreams
        .route("/api/admin/upstreams/fetch-models", post(handlers::admin::admin_fetch_models_preview))
        .route("/api/admin/upstreams", get(handlers::admin::admin_list_upstreams)
            .post(handlers::admin::admin_create_upstream))
        .route("/api/admin/upstreams/{id}", get(handlers::admin::admin_get_upstream)
            .put(handlers::admin::admin_update_upstream)
            .delete(handlers::admin::admin_delete_upstream))
        .route("/api/admin/upstreams/{id}/enabled", patch(handlers::admin::admin_set_upstream_enabled))
        .route("/api/admin/upstreams/{id}/priority", patch(handlers::admin::admin_set_upstream_priority))
        .route("/api/admin/upstreams/{id}/test", post(handlers::admin::admin_test_upstream))
        .route("/api/admin/upstreams/{id}/models", post(handlers::admin::admin_fetch_upstream_models))
        .route("/api/admin/upstreams/{id}/balance", post(handlers::admin::admin_fetch_upstream_balance))
        // Tokens
        .route("/api/admin/tokens", get(handlers::admin::admin_list_tokens)
            .post(handlers::admin::admin_create_token))
        .route("/api/admin/tokens/{id}", get(handlers::admin::admin_get_token)
            .put(handlers::admin::admin_update_token)
            .delete(handlers::admin::admin_delete_token))
        .route("/api/admin/tokens/{id}/enabled", patch(handlers::admin::admin_set_token_enabled))
        // Logs
        .route("/api/admin/logs", get(handlers::admin::admin_list_logs))
        .route("/api/admin/logs/{id}", get(handlers::admin::admin_get_log_detail));

    let app = Router::new()
        .route("/health", get(handlers::admin::health_check))
        .route("/", get(|| async { axum::response::Redirect::to("/admin") }))
        .route("/admin", get(serve_admin_html))
        .route("/admin-v2", get(serve_admin_v2_html))
        .route("/v1/{*path}", any(handlers::proxy::proxy_handler))
        .nest_service("/static", tower_http::services::ServeDir::new("static"))
        .nest_service("/static-v2", tower_http::services::ServeDir::new("static-v2"))
        .merge(admin_routes)
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::new()
            .allow_origin(AllowOrigin::any())
            .allow_methods(Any)
            .allow_headers(Any))
        .with_state(state);

    // 8. Start server
    tracing::info!("WildToken starting on http://{}", bind_addr);
    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

/// Serve admin static HTML page
async fn serve_admin_html() -> axum::response::Response {
    serve_html_file("static/admin.html").await
}

/// Serve the ui-ux-pro-max dark OLED admin console (static-v2).
async fn serve_admin_v2_html() -> axum::response::Response {
    serve_html_file("static-v2/admin.html").await
}

async fn serve_html_file(path: &str) -> axum::response::Response {
    match tokio::fs::read_to_string(path).await {
        Ok(html) => axum::response::Response::builder()
            .header("content-type", "text/html; charset=utf-8")
            .body(axum::body::Body::from(html))
            .unwrap(),
        Err(_) => axum::response::Response::builder()
            .status(axum::http::StatusCode::NOT_FOUND)
            .body(axum::body::Body::from("Admin page not found"))
            .unwrap(),
    }
}
