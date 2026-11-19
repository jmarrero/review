//! Configured attach gateway. Targets and credentials are never taken from a
//! browser request. The deployment's operator-only proxy/ACL authenticates the
//! person; Origin admission keeps a foreign page from using that authority.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, ensure};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path as RoutePath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Router, routing::get};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::io::AsyncReadExt;
use tokio::sync::Semaphore;
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest};

const MAX_CONFIG: usize = 64 * 1024;
const MAX_SESSIONS: usize = 16;
const MAX_CONNECTIONS: usize = 8;
const MAX_MESSAGE: usize = 1024 * 1024;
const HANDSHAKE: Duration = Duration::from_secs(10);
const IDLE: Duration = Duration::from_secs(5 * 60);
const LIFETIME: Duration = Duration::from_secs(60 * 60);
const WRITE: Duration = Duration::from_secs(10);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    origin: String,
    sessions: HashMap<String, Target>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Target {
    #[serde(default)]
    label: Option<String>,
    url: String,
    token_file: PathBuf,
    #[serde(skip, default = "session_slot")]
    busy: Arc<Semaphore>,
}

fn session_slot() -> Arc<Semaphore> {
    Arc::new(Semaphore::new(1))
}

pub struct Bridge {
    config: Config,
    slots: Arc<Semaphore>,
}

/// Read at most LIMIT bytes, including for a file that grows during the read.
async fn bounded_file(path: &Path, limit: usize) -> Result<Vec<u8>> {
    let file = tokio::fs::File::open(path).await?;
    let mut bytes = Vec::new();
    file.take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .await?;
    ensure!(bytes.len() <= limit, "file exceeds size limit");
    Ok(bytes)
}

impl Bridge {
    pub async fn load(path: &Path) -> Result<Arc<Self>> {
        // Never include parser errors: they can quote private config contents.
        let bytes = bounded_file(path, MAX_CONFIG)
            .await
            .context("reading ACP config")?;
        let config = Self::parse(&bytes)?;
        Ok(Arc::new(Self {
            config,
            slots: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
        }))
    }

    fn parse(bytes: &[u8]) -> Result<Config> {
        let config: Config = serde_json::from_slice(bytes)
            .map_err(|_| anyhow::anyhow!("invalid ACP config JSON"))?;
        let origin = reqwest::Url::parse(&config.origin)
            .map_err(|_| anyhow::anyhow!("invalid ACP origin"))?;
        ensure!(
            config.origin.len() <= 512
                && origin.origin().ascii_serialization() == config.origin
                && (origin.scheme() == "https"
                    || (origin.scheme() == "http"
                        && matches!(origin.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))),
            "ACP origin must be an exact HTTPS origin (HTTP only on loopback)"
        );
        ensure!(
            (1..=MAX_SESSIONS).contains(&config.sessions.len()),
            "ACP config needs 1 to 16 sessions"
        );
        for (id, target) in &config.sessions {
            // Bound public display metadata; never serialize the target itself.
            ensure!(
                target
                    .label
                    .as_ref()
                    .is_none_or(|label| !label.trim().is_empty()
                        && label.len() <= 64
                        && !label.chars().any(char::is_control)),
                "ACP label must be 1 to 64 bytes without control characters"
            );
            ensure!(
                !id.is_empty()
                    && id.len() <= 64
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b)),
                "invalid ACP session id"
            );
            let url = reqwest::Url::parse(&target.url)
                .map_err(|_| anyhow::anyhow!("invalid ACP target URL"))?;
            ensure!(
                target.url.len() <= 2048
                    && matches!(url.scheme(), "ws" | "wss")
                    && url.host_str().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.query().is_none()
                    && url.fragment().is_none(),
                "ACP target needs a ws/wss URL without credentials, query or fragment"
            );
            ensure!(
                target.token_file.is_absolute(),
                "ACP token_file must be absolute"
            );
        }
        Ok(config)
    }

    pub fn router(self: Arc<Self>) -> Router {
        Router::new()
            // Browsers omit Origin on same-origin GET; POST discovery keeps the
            // bridge's exact-Origin rule without trusting Referer/Fetch Metadata.
            .route("/api/acp", get(list).post(list))
            .route("/api/acp/{session}", get(attach))
            .with_state(self)
    }
}

fn admitted(bridge: &Bridge, headers: &HeaderMap) -> bool {
    let mut origins = headers.get_all("origin").iter();
    matches!((origins.next(), origins.next()), (Some(origin), None) if origin.as_bytes() == bridge.config.origin.as_bytes())
}

async fn list(State(bridge): State<Arc<Bridge>>, headers: HeaderMap) -> Response {
    if !admitted(&bridge, &headers) {
        return (StatusCode::FORBIDDEN, "ACP origin refused").into_response();
    }
    let mut sessions: Vec<_> = bridge.config.sessions.iter().collect();
    sessions.sort_by_key(|(id, _)| *id);
    let public: Vec<_> = sessions.into_iter().map(|(id, target)| {
        serde_json::json!({"id": id, "label": target.label.as_ref().unwrap_or(id)})
    }).collect();
    ([("cache-control", "no-store")], axum::Json(public)).into_response()
}

async fn attach(
    State(bridge): State<Arc<Bridge>>,
    RoutePath(session): RoutePath<String>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !admitted(&bridge, &headers) {
        return (StatusCode::FORBIDDEN, "ACP origin refused").into_response();
    }
    let Some(target) = bridge.config.sessions.get(&session) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let (Ok(slot), Ok(busy)) = (
        bridge.slots.clone().try_acquire_owned(),
        target.busy.clone().try_acquire_owned(),
    ) else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    // Bound token reads and connection establishment together. No incoming
    // headers (cookies, Authorization, Origin, proxy identity) go upstream.
    let connected = tokio::time::timeout(HANDSHAKE, async {
        let token = bounded_file(&target.token_file, 1026).await?;
        let token = std::str::from_utf8(&token)?.trim();
        ensure!(
            (32..=1024).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_graphic()),
            "invalid attach token"
        );
        let mut request = target.url.clone().into_client_request()?;
        let mut bearer = tungstenite::http::HeaderValue::from_str(&format!("Bearer {token}"))?;
        bearer.set_sensitive(true);
        request.headers_mut().insert("authorization", bearer);
        let config = tungstenite::protocol::WebSocketConfig::default()
            .max_message_size(Some(MAX_MESSAGE))
            .max_frame_size(Some(MAX_MESSAGE));
        let (socket, _) =
            tokio_tungstenite::connect_async_with_config(request, Some(config), false).await?;
        Ok::<_, anyhow::Error>(socket)
    })
    .await;
    let Ok(Ok(upstream)) = connected else {
        // Upstream errors can contain the request, secret, address or body.
        return (StatusCode::BAD_GATEWAY, "ACP listener unavailable").into_response();
    };
    ws.max_message_size(MAX_MESSAGE)
        .max_frame_size(MAX_MESSAGE)
        .on_upgrade(move |browser| async move {
            let _permits = (slot, busy);
            let _ = tokio::time::timeout(LIFETIME, relay(browser, upstream)).await;
        })
}

async fn relay<S>(mut browser: WebSocket, mut upstream: tokio_tungstenite::WebSocketStream<S>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        // No queues: each direction must finish a bounded write before the
        // next read. Either disconnect/error drops both transports. Control
        // frames are handled locally, not forwarded with upstream close text.
        let next = tokio::time::timeout(IDLE, async {
            tokio::select! {
                msg = browser.recv() => match msg {
                    Some(Ok(Message::Text(text))) => tokio::time::timeout(WRITE, upstream.send(tungstenite::Message::Text(text.as_str().into()))).await.is_ok_and(|r| r.is_ok()),
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => true,
                    _ => false,
                },
                msg = upstream.next() => match msg {
                    Some(Ok(tungstenite::Message::Text(text))) => tokio::time::timeout(WRITE, browser.send(Message::Text(text.as_str().into()))).await.is_ok_and(|r| r.is_ok()),
                    Some(Ok(tungstenite::Message::Ping(_) | tungstenite::Message::Pong(_))) => true,
                    _ => false,
                },
            }
        }).await;
        if !matches!(next, Ok(true)) {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use tokio::net::{TcpListener, TcpStream};
    use tokio_tungstenite::{WebSocketStream, tungstenite::Message as Wire};

    const ORIGIN: &str = "https://control.example";
    const SECRET: &str = "fixture-attach-secret-for-run-one-only";

    fn config(url: &str, file: &Path) -> Value {
        json!({"origin": ORIGIN, "sessions": {"run-42": {"url": url, "token_file": file}}})
    }

    fn bridge(value: &Value) -> Arc<Bridge> {
        Arc::new(Bridge {
            config: Bridge::parse(&serde_json::to_vec(value).unwrap()).unwrap(),
            slots: Arc::new(Semaphore::new(8)),
        })
    }

    async fn serve(bridge: Option<Arc<Bridge>>) -> String {
        let (_, rx) = tokio::sync::watch::channel(Arc::new(crate::state::State::empty()));
        let app = crate::server::router_with_acp(rx, None, vec!["control.example".into()], bridge);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("ws://{addr}/api/acp/run-42")
    }

    fn request(url: &str) -> tungstenite::handshake::client::Request {
        let mut req = url.into_client_request().unwrap();
        req.headers_mut().insert("origin", ORIGIN.parse().unwrap());
        req
    }

    async fn refused(req: tungstenite::handshake::client::Request, status: u16) -> String {
        let err = tokio_tungstenite::connect_async(req).await.unwrap_err();
        let tungstenite::Error::Http(response) = err else {
            panic!("not an HTTP refusal: {err}")
        };
        assert_eq!(response.status().as_u16(), status);
        String::from_utf8(response.body().clone().unwrap_or_default()).unwrap()
    }

    // tungstenite fixes the callback's error type to an HTTP response.
    #[allow(clippy::result_large_err)]
    async fn accepted(listener: &TcpListener, token: &str) -> WebSocketStream<TcpStream> {
        let (tcp, _) = listener.accept().await.unwrap();
        tokio_tungstenite::accept_hdr_async(
            tcp,
            |req: &tungstenite::handshake::server::Request, response| {
                assert_eq!(req.headers()["authorization"], format!("Bearer {token}"));
                for name in [
                    "origin",
                    "cookie",
                    "tailscale-user-login",
                    "sec-websocket-protocol",
                ] {
                    assert!(!req.headers().contains_key(name), "forwarded {name}");
                }
                Ok(response)
            },
        )
        .await
        .unwrap()
    }

    async fn next(
        socket: &mut WebSocketStream<impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>,
    ) -> Wire {
        tokio::time::timeout(Duration::from_secs(3), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
    }

    async fn disconnected<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
        socket: &mut WebSocketStream<S>,
    ) {
        assert!(
            tokio::time::timeout(Duration::from_secs(3), socket.next())
                .await
                .unwrap()
                .is_none_or(|m| m.is_err() || matches!(m, Ok(Wire::Close(_))))
        );
    }

    #[tokio::test]
    async fn recorded_exchange_and_rotation() {
        let dir = tempfile::tempdir().unwrap();
        let token = dir.path().join("attach");
        tokio::fs::write(&token, SECRET).await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let gateway = bridge(&config(
            &format!("ws://{}/", listener.local_addr().unwrap()),
            &token,
        ));
        let url = serve(Some(gateway.clone())).await;
        let fixture: Value = serde_json::from_str(include_str!("../fixtures/acp.json")).unwrap();
        let server = tokio::spawn(async move {
            let mut socket = accepted(&listener, SECRET).await;
            for exchange in fixture["exchanges"].as_array().unwrap() {
                let client = next(&mut socket).await;
                assert_eq!(
                    serde_json::from_str::<Value>(client.to_text().unwrap()).unwrap(),
                    exchange["client"]
                );
                for msg in exchange["server"].as_array().unwrap() {
                    socket.send(Wire::text(msg.to_string())).await.unwrap();
                }
            }
            // Browser close tears down the listener transport too.
            assert!(
                tokio::time::timeout(Duration::from_secs(3), socket.next())
                    .await
                    .unwrap()
                    .is_none_or(|m| m.is_err() || matches!(m, Ok(Wire::Close(_))))
            );
            let mut socket = accepted(&listener, "fixture-rotated-attach-secret-run-two").await;
            socket.send(Wire::text("reconnected")).await.unwrap();
            socket.close(None).await.unwrap();
        });
        let mut req = request(&url);
        req.headers_mut().insert(
            "authorization",
            "Bearer browser-value-not-forwarded".parse().unwrap(),
        );
        req.headers_mut()
            .insert("cookie", "operator=session".parse().unwrap());
        req.headers_mut()
            .insert("tailscale-user-login", "forged".parse().unwrap());
        let (mut browser, response) = tokio_tungstenite::connect_async(req).await.unwrap();
        assert!(!format!("{response:?}").contains(SECRET));
        refused(request(&url), 429).await;
        let fixture: Value = serde_json::from_str(include_str!("../fixtures/acp.json")).unwrap();
        for exchange in fixture["exchanges"].as_array().unwrap() {
            browser
                .send(Wire::text(exchange["client"].to_string()))
                .await
                .unwrap();
            for expected in exchange["server"].as_array().unwrap() {
                let got = next(&mut browser).await;
                assert!(!got.to_text().unwrap().contains(SECRET));
                assert_eq!(
                    serde_json::from_str::<Value>(got.to_text().unwrap()).unwrap(),
                    *expected
                );
            }
        }
        browser.close(None).await.unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while gateway.config.sessions["run-42"].busy.available_permits() == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        tokio::fs::write(&token, "fixture-rotated-attach-secret-run-two\n")
            .await
            .unwrap();
        let (mut browser, _) = tokio_tungstenite::connect_async(request(&url))
            .await
            .unwrap();
        assert_eq!(next(&mut browser).await, Wire::text("reconnected"));
        assert!(
            tokio::time::timeout(Duration::from_secs(3), browser.next())
                .await
                .unwrap()
                .is_none_or(|m| m.is_err() || matches!(m, Ok(Wire::Close(_))))
        );
        server.await.unwrap();
    }

    #[tokio::test]
    #[allow(clippy::result_large_err)] // tungstenite's handshake callback type
    async fn admission_and_upstream_failure_are_private() {
        let dir = tempfile::tempdir().unwrap();
        let token = dir.path().join("attach");
        tokio::fs::write(&token, SECRET).await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let gateway = bridge(&config(
            &format!("ws://{}/private-listener", listener.local_addr().unwrap()),
            &token,
        ));
        let url = serve(Some(gateway.clone())).await;
        refused(request(&serve(None).await), 404).await;
        for origin in [None, Some("null"), Some("https://evil.example")] {
            let mut req = request(&url);
            req.headers_mut().remove("origin");
            if let Some(origin) = origin {
                req.headers_mut().insert("origin", origin.parse().unwrap());
            }
            refused(req, 403).await;
        }
        let mut duplicate = request(&url);
        duplicate
            .headers_mut()
            .append("origin", ORIGIN.parse().unwrap());
        refused(duplicate, 403).await;
        refused(request(&url.replace("run-42", "unknown")), 404).await;
        let slots = gateway.slots.clone().acquire_many_owned(8).await.unwrap();
        refused(request(&url), 429).await;
        drop(slots);
        // None of the refusals attempted an upstream connection.
        assert!(
            tokio::time::timeout(Duration::from_millis(30), listener.accept())
                .await
                .is_err()
        );
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let _ = tokio_tungstenite::accept_hdr_async(
                tcp,
                |_: &tungstenite::handshake::server::Request, _| {
                    let mut response = tungstenite::handshake::server::ErrorResponse::new(Some(
                        format!("private-listener {SECRET}"),
                    ));
                    *response.status_mut() = StatusCode::FORBIDDEN;
                    Err(response)
                },
            )
            .await;
        });
        let body = refused(request(&url), 502).await;
        assert_eq!(body, "ACP listener unavailable");
        assert!(!body.contains(SECRET));
        server.await.unwrap();
        tokio::fs::write(&token, "invalid").await.unwrap();
        assert_eq!(refused(request(&url), 502).await, body);
        tokio::fs::remove_file(&token).await.unwrap();
        assert_eq!(refused(request(&url), 502).await, body);
    }

    #[tokio::test]
    async fn binary_and_oversize_messages_disconnect_both_sides() {
        for from_browser in [true, false] {
            for message in [
                Wire::Binary(vec![1, 2].into()),
                Wire::text("x".repeat(MAX_MESSAGE + 1)),
            ] {
                let dir = tempfile::tempdir().unwrap();
                let token = dir.path().join("attach");
                tokio::fs::write(&token, SECRET).await.unwrap();
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let url = serve(Some(bridge(&config(
                    &format!("ws://{}/", listener.local_addr().unwrap()),
                    &token,
                ))))
                .await;
                let server = tokio::spawn(async move { accepted(&listener, SECRET).await });
                let (mut browser, _) = tokio_tungstenite::connect_async(request(&url))
                    .await
                    .unwrap();
                let mut upstream = server.await.unwrap();
                if from_browser {
                    browser.send(message).await.unwrap();
                } else {
                    upstream.send(message).await.unwrap();
                }
                disconnected(&mut browser).await;
                disconnected(&mut upstream).await;
            }
        }
    }

    #[test]
    fn config_validation() {
        let base = config("wss://listener.example/", Path::new("/run/attach"));
        bridge(&base);
        for url in [
            "https://listener.example/",
            "ws://user:pass@listener.example/",
            "ws://listener.example/?token=secret",
            "ws://listener.example/#x",
        ] {
            let mut value = base.clone();
            value["sessions"]["run-42"]["url"] = json!(url);
            assert!(Bridge::parse(&serde_json::to_vec(&value).unwrap()).is_err());
        }
        for origin in [
            "*",
            "null",
            "http://control.example",
            "https://control.example/",
            "https://control.example/path",
        ] {
            let mut value = base.clone();
            value["origin"] = json!(origin);
            assert!(Bridge::parse(&serde_json::to_vec(&value).unwrap()).is_err());
        }
        for sessions in [
            json!({}),
            json!({"bad.id": {"url":"ws://host", "token_file":"/run/token"}}),
            json!({"ok": {"url":"ws://host", "token_file":"relative"}}),
        ] {
            let mut value = base.clone();
            value["sessions"] = sessions;
            assert!(Bridge::parse(&serde_json::to_vec(&value).unwrap()).is_err());
        }
        let mut value = base.clone();
        value["sessions"] = Value::Object(
            (0..=MAX_SESSIONS)
                .map(|i| (format!("run-{i}"), base["sessions"]["run-42"].clone()))
                .collect(),
        );
        assert!(Bridge::parse(&serde_json::to_vec(&value).unwrap()).is_err());
        assert_eq!(
            Bridge::parse(b"secret invalid json")
                .err()
                .unwrap()
                .to_string(),
            "invalid ACP config JSON"
        );
    }

    #[tokio::test]
    async fn listing_is_public_metadata_only_and_origin_gated() {
        let mut value = config("wss://private.example/secret", Path::new("/private/token"));
        value["sessions"]["other"] = value["sessions"]["run-42"].clone();
        value["sessions"]["other"]["label"] = json!("Provider");
        let url = serve(Some(bridge(&value)))
            .await
            .replace("ws://", "http://")
            .replace("/run-42", "");
        let client = reqwest::Client::new();
        for origin in [None, Some("https://foreign.example")] {
            let mut req = client.get(&url);
            if let Some(origin) = origin {
                req = req.header("origin", origin);
            }
            assert_eq!(req.send().await.unwrap().status(), StatusCode::FORBIDDEN);
        }
        let response = client
            .get(&url)
            .header("origin", ORIGIN)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.json::<Value>().await.unwrap(),
            json!([
                {"id":"other", "label":"Provider"}, {"id":"run-42", "label":"run-42"}
            ])
        );
        for label in ["".to_string(), "x".repeat(65), "bad\nlabel".to_string()] {
            value["sessions"]["other"]["label"] = json!(label);
            assert!(Bridge::parse(&serde_json::to_vec(&value).unwrap()).is_err());
        }
    }

    #[tokio::test]
    async fn bounded_config_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config");
        tokio::fs::write(&path, vec![b' '; MAX_CONFIG + 1])
            .await
            .unwrap();
        assert!(Bridge::load(&path).await.is_err());
        tokio::fs::write(
            &path,
            config("ws://localhost/", &dir.path().join("token")).to_string(),
        )
        .await
        .unwrap();
        Bridge::load(&path).await.unwrap();
    }

    #[tokio::test]
    async fn stalled_listener_times_out_and_releases_slot() {
        let dir = tempfile::tempdir().unwrap();
        let token = dir.path().join("attach");
        tokio::fs::write(&token, SECRET).await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let gateway = bridge(&config(
            &format!("ws://{}/", listener.local_addr().unwrap()),
            &token,
        ));
        let url = serve(Some(gateway.clone())).await;
        let result = tokio::spawn(async move { refused(request(&url), 502).await });
        let (_parked, _) = listener.accept().await.unwrap();
        assert_eq!(
            tokio::time::timeout(HANDSHAKE + Duration::from_secs(3), result)
                .await
                .unwrap()
                .unwrap(),
            "ACP listener unavailable"
        );
        assert_eq!(gateway.slots.available_permits(), MAX_CONNECTIONS);
        assert_eq!(
            gateway.config.sessions["run-42"].busy.available_permits(),
            1
        );
    }

    #[tokio::test]
    async fn idle_connection_is_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let token = dir.path().join("attach");
        tokio::fs::write(&token, SECRET).await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = serve(Some(bridge(&config(
            &format!("ws://{}/", listener.local_addr().unwrap()),
            &token,
        ))))
        .await;
        let server = tokio::spawn(async move { accepted(&listener, SECRET).await });
        let (mut browser, _) = tokio_tungstenite::connect_async(request(&url))
            .await
            .unwrap();
        let mut upstream = server.await.unwrap();
        tokio::time::pause();
        tokio::time::advance(IDLE + Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
        tokio::time::resume();
        disconnected(&mut browser).await;
        disconnected(&mut upstream).await;
    }
}
