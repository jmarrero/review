//! The HTTP side: the state's read endpoints, its updates over SSE, and
//! the built app's static files, plus optional configured ACP attachments.

use std::convert::Infallible;
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, Request, State as Extract};
use axum::http::StatusCode;
use axum::http::header::{CACHE_CONTROL, HOST};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use futures_util::StreamExt;
use tokio::sync::watch;
use tokio_stream::wrappers::WatchStream;
use tower_http::services::ServeDir;

use crate::state::State;
use crate::version::Version;

pub type Shared = watch::Receiver<Arc<State>>;

/// The SSE event carrying a whole state document.
pub const STATE_EVENT: &str = "state";

/// How often an idle event stream sends a comment, so proxies keep it open.
const KEEPALIVE: Duration = Duration::from_secs(20);

/// `allowed_hosts` are the host names, besides localhost and IP
/// addresses, that requests may name in their Host header.
#[cfg(test)]
pub fn router(state: Shared, static_dir: Option<PathBuf>, allowed_hosts: Vec<String>) -> Router {
    router_with_acp(state, static_dir, allowed_hosts, None)
}

pub fn router_with_acp(
    state: Shared,
    static_dir: Option<PathBuf>,
    allowed_hosts: Vec<String>,
    acp: Option<Arc<crate::acp::Bridge>>,
) -> Router {
    let api = Router::new()
        .route("/healthz", get(health))
        .route("/api/state", get(whole))
        .route("/api/v1/state", get(whole))
        .route("/api/repos/{owner}/{repo}", get(repo))
        .route("/api/events", get(events))
        .with_state(state);
    let api = match acp {
        Some(bridge) => api.merge(bridge.router()),
        None => api,
    };
    let app = match static_dir {
        Some(dir) => api.fallback_service(ServeDir::new(dir)),
        None => api,
    };
    app.layer(middleware::from_fn_with_state(
        Arc::<[String]>::from(allowed_hosts),
        allowed_host,
    ))
}

/// Refuse a request whose Host is a domain name other than localhost or
/// one of `allowed`. A page on any site the operator opens could otherwise
/// point its own name at the service's address (DNS rebinding) and read
/// the state as same-origin.
async fn allowed_host(
    Extract(allowed): Extract<Arc<[String]>>,
    req: Request,
    next: Next,
) -> Response {
    let host = req
        .headers()
        .get(HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    if is_allowed(host, &allowed) {
        next.run(req).await
    } else {
        (
            StatusCode::FORBIDDEN,
            "control-app answers only to localhost, an IP address or an --allow-host name\n",
        )
            .into_response()
    }
}

/// Whether a Host header names localhost, an IP address or one of
/// `allowed`, with or without a port.
fn is_allowed(host: &str, allowed: &[String]) -> bool {
    let name = match host.strip_prefix('[') {
        Some(rest) => rest.split(']').next().unwrap_or(""),
        None => host.rsplit_once(':').map_or(host, |(name, _)| name),
    };
    name.eq_ignore_ascii_case("localhost")
        || name.parse::<IpAddr>().is_ok()
        || allowed.iter().any(|a| a.eq_ignore_ascii_case(name))
}

/// Liveness and build identity, independent of GitHub and refresh progress.
async fn health() -> impl IntoResponse {
    Json(serde_json::json!({"status": "ok", "version": Version::default()}))
}

async fn whole(Extract(state): Extract<Shared>) -> Response {
    let state = state.borrow().clone();
    Json(&*state).into_response()
}

async fn repo(
    Extract(state): Extract<Shared>,
    Path((owner, repo)): Path<(String, String)>,
) -> Response {
    let state = state.borrow().clone();
    Json(state.repo(&format!("{owner}/{repo}"))).into_response()
}

/// The current state on connecting, then each refresh's, each with the
/// refresh count as its id. Every event is the whole state, so a client
/// reconnecting with Last-Event-ID just resyncs from the first. The stream
/// ends when the refresher stops, which lets shutdown finish.
async fn events(Extract(state): Extract<Shared>) -> impl IntoResponse {
    let stream = WatchStream::new(state).map(|s| {
        Ok::<_, Infallible>(
            Event::default()
                .event(STATE_EVENT)
                .id(s.generation.to_string())
                .data(serde_json::to_string(&*s).expect("serializing the state")),
        )
    });
    (
        [(CACHE_CONTROL, "no-cache")],
        Sse::new(stream).keep_alive(KeepAlive::new().interval(KEEPALIVE)),
    )
}

#[cfg(test)]
pub(crate) mod tests {
    use serde_json::Value;

    use super::*;
    use crate::state::refresh;
    use crate::state::tests::Recorded;

    async fn serve(rx: Shared, static_dir: Option<PathBuf>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(
                listener,
                router(rx, static_dir, vec!["review.example.ts.net".into()]),
            )
            .await
            .unwrap()
        });
        format!("http://{addr}")
    }

    /// The id and data of the next complete SSE event of type `state`.
    pub(crate) async fn next_state(
        resp: &mut reqwest::Response,
        buf: &mut String,
    ) -> (String, Value) {
        loop {
            if let Some(end) = buf.find("\n\n") {
                let event: String = buf.drain(..end + 2).collect();
                if event.lines().any(|l| l == "event: state") {
                    let field = |name| {
                        event
                            .lines()
                            .filter_map(|l| l.strip_prefix(name))
                            .collect::<String>()
                    };
                    return (
                        field("id: "),
                        serde_json::from_str(&field("data: ")).unwrap(),
                    );
                }
                continue;
            }
            let chunk = resp.chunk().await.unwrap().expect("the stream ended");
            buf.push_str(std::str::from_utf8(&chunk).unwrap());
        }
    }

    #[tokio::test]
    async fn endpoints_and_events() {
        let (tx, rx) = watch::channel(Arc::new(State::empty()));
        let dir = std::env::temp_dir().join(format!("review-service-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.html"), "<p>app</p>").unwrap();
        let base = serve(rx, Some(dir.clone())).await;
        let http = reqwest::Client::new();

        let version = serde_json::json!({
            "tag": option_env!("REVIEW_SERVICE_TAG").filter(|s| !s.is_empty()),
            "commit": option_env!("REVIEW_SERVICE_COMMIT").filter(|s| !s.is_empty()),
        });
        // Both endpoints work before GitHub has been read even once.
        let health: Value = http
            .get(format!("{base}/healthz"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(
            health,
            serde_json::json!({"status": "ok", "version": version})
        );
        let initial: Value = http
            .get(format!("{base}/api/state"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(initial["version"], version);
        assert_eq!(initial["schema"], "review-service/v1");
        assert_eq!(
            initial["schemaAliases"],
            serde_json::json!(["control-app/v1"])
        );

        let mut events = http.get(format!("{base}/api/events")).send().await.unwrap();
        assert_eq!(events.headers()["content-type"], "text/event-stream");
        assert_eq!(events.headers()["cache-control"], "no-cache");
        let mut buf = String::new();
        let (id, first) = next_state(&mut events, &mut buf).await;
        assert_eq!(id, "0");
        assert_eq!(first["schema"], "review-service/v1");
        assert_eq!(
            first["schemaAliases"],
            serde_json::json!(["control-app/v1"])
        );
        assert_eq!(first, initial);
        assert_eq!(first["version"], version);
        assert_eq!(first["refreshedAt"], Value::Null);

        let mut state = refresh(
            &Recorded::fixture(),
            &State::empty(),
            "2026-11-07T12:00:00Z",
        )
        .await;
        state.decision = Some(crate::state::Section {
            items: vec![
                serde_json::from_str(include_str!("../../test/fixtures/service-decision.json"))
                    .unwrap(),
            ],
            complete: false,
            read_at: Some("2026-11-07T12:00:00Z".into()),
            error: Some("board preview has incomplete reads".into()),
        });
        tx.send(Arc::new(state)).unwrap();
        let (id, second) = next_state(&mut events, &mut buf).await;
        assert_eq!(id, "1");
        assert_eq!(second["schema"], "review-service/v1");
        assert_eq!(
            second["schemaAliases"],
            serde_json::json!(["control-app/v1"])
        );
        assert_eq!(second["refreshedAt"], "2026-11-07T12:00:00Z");
        assert_eq!(second["generation"], 1);
        assert_eq!(second["decision"]["items"][0]["failures"], 0);
        assert_eq!(
            second["decision"]["items"][0]["holds"][0]["item"],
            "example/work#2"
        );

        // Both a stale and a current last id resync with the whole state,
        // including the legacy schema and its equivalent alias.
        for last_id in ["0", "1"] {
            let mut again = http
                .get(format!("{base}/api/events"))
                .header("last-event-id", last_id)
                .send()
                .await
                .unwrap();
            let (id, resynced) = next_state(&mut again, &mut String::new()).await;
            assert_eq!((id.as_str(), &resynced), ("1", &second));
        }

        for path in ["/api/state", "/api/v1/state"] {
            let whole: Value = http
                .get(format!("{base}{path}"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(whole, second);
            assert_eq!(whole["version"], version);
        }
        let board: Value = http
            .get(format!("{base}/api/repos/bootc-dev/BOOTC"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(board["repository"], "bootc-dev/BOOTC");
        assert_eq!(board["prs"]["items"][0]["number"], 1201);
        assert_eq!(board["prs"]["complete"], true);
        assert_eq!(
            board["waiting"]["items"][0]["reasons"],
            serde_json::json!(["review-requested", "assigned"])
        );

        let page = http
            .get(format!("{base}/"))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert_eq!(page, "<p>app</p>");
        let post = http.post(format!("{base}/api/state")).send().await.unwrap();
        assert_eq!(post.status(), 405, "nothing writes");
        let rebound = http
            .get(format!("{base}/api/state"))
            .header("host", "evil.example:8787")
            .send()
            .await
            .unwrap();
        assert_eq!(rebound.status(), 403);
        let proxied = http
            .get(format!("{base}/healthz"))
            .header("host", "REVIEW.example.ts.net")
            .send()
            .await
            .unwrap();
        assert_eq!(proxied.status(), 200);
        assert_eq!(proxied.json::<Value>().await.unwrap(), health);

        // When the refresher stops, as on SIGTERM, the streams end, so a
        // graceful shutdown doesn't wait on them.
        drop(tx);
        while let Some(chunk) = events.chunk().await.unwrap() {
            assert!(!chunk.is_empty());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn allowed_hosts() {
        let allowed = ["review.example.ts.net".to_owned()];
        for host in [
            "localhost:8080",
            "LOCALHOST",
            "127.0.0.1:8080",
            "[::1]:8080",
            "[::1]",
            "10.0.0.2",
            "review.example.ts.net",
            "Review.Example.ts.net:443",
        ] {
            assert!(is_allowed(host, &allowed), "{host}");
        }
        for host in [
            "",
            "evil.example",
            "evil.example:8080",
            "localhost.evil.example",
            "127.0.0.1.nip.io:8080",
            "review.example.ts.net.evil.example",
            "example.ts.net",
        ] {
            assert!(!is_allowed(host, &allowed), "{host}");
        }
        assert!(!is_allowed("review.example.ts.net", &[]));
    }
}
