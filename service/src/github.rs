//! A read-only REST client for the GitHub, Forgejo or Kubernetes API. It has only
//! `get`, so the service can't write with the token it holds. Each GET is
//! conditional on the ETag of the last answer to the same path and credential: an
//! unchanged answer is a 304, which costs no rate budget, and is served
//! from the cache.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use reqwest::StatusCode;
use reqwest::header::{ACCEPT, AUTHORIZATION, ETAG, HeaderValue, IF_NONE_MATCH, USER_AGENT};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::token::TokenSource;

pub const API_ROOT: &str = "https://api.github.com";

/// Give up on a request GitHub hasn't answered in this long, as the app does.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// Give up on a Forgejo or Kubernetes request sooner: a refresh makes rounds
/// of them, up to three for Forgejo, and publishing GitHub's sections waits
/// for the last.
const SHORT_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

const API_VERSION: &str = "2022-11-28";

// Page counts alone do not bound memory: even one upstream item or error
// response can be arbitrarily large. Bound bytes before parsing or caching.
const MAX_BODY: usize = 2 * 1024 * 1024;

/// Where the state's reads come from: GitHub, or recorded answers in tests.
pub trait Source: Sync {
    /// The JSON answer to a GET of `path` (with its query), relative to the API root.
    fn get(&self, path: &str) -> impl Future<Output = Result<Value>> + Send;
}

/// Scope validators and bodies to the credential actually sent on the request.
/// Keep only its digest in the cache, never the bearer token. Root, API type and
/// representation headers are fixed for the lifetime of the owning client.
#[derive(Clone, PartialEq, Eq, Hash)]
struct CacheKey {
    path: String,
    credential: [u8; 32],
}

impl CacheKey {
    fn new(path: &str, token: &str) -> Self {
        Self {
            path: path.to_owned(),
            credential: Sha256::digest(token.as_bytes()).into(),
        }
    }
}

/// The cached answers by path and credential. `prev` holds the last refresh's, `next`
/// this one's; `sweep` drops what a refresh didn't ask for again, so the
/// cache holds at most two refreshes' answers.
#[derive(Default)]
struct Cache {
    prev: HashMap<CacheKey, (String, Value)>,
    next: HashMap<CacheKey, (String, Value)>,
}

/// Which API a client speaks, which decides how it sends the token.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Api {
    GitHub,
    Forgejo,
    Kubernetes,
}

pub struct Client {
    http: reqwest::Client,
    api: Api,
    root: String,
    token: Arc<TokenSource>,
    cache: Mutex<Cache>,
}

impl Client {
    /// A GitHub client for the API at `root`.
    pub fn new(token: impl Into<Arc<TokenSource>>, root: &str) -> Result<Self> {
        Self::build(Api::GitHub, token.into(), root, None)
    }

    /// A Forgejo client for the API at `root`, a base URL ending in /api/v1.
    pub fn forgejo(token: impl Into<Arc<TokenSource>>, root: &str) -> Result<Self> {
        Self::build(Api::Forgejo, token.into(), root, None)
    }

    /// A Kubernetes client for the API server at `root`, trusting only the
    /// PEM certificates in `ca`.
    pub fn kubernetes(token: impl Into<Arc<TokenSource>>, root: &str, ca: &[u8]) -> Result<Self> {
        Self::build(Api::Kubernetes, token.into(), root, Some(ca))
    }

    fn build(api: Api, token: Arc<TokenSource>, root: &str, ca: Option<&[u8]>) -> Result<Self> {
        let timeout = match api {
            Api::GitHub => REQUEST_TIMEOUT,
            Api::Forgejo | Api::Kubernetes => SHORT_REQUEST_TIMEOUT,
        };
        let mut http = reqwest::Client::builder().timeout(timeout);
        if let Some(ca) = ca {
            let certs = reqwest::Certificate::from_pem_bundle(ca).context("reading the CA")?;
            ensure!(!certs.is_empty(), "the CA has no certificate");
            http = http.tls_certs_only(certs);
        }
        let http = http.build().context("building the HTTP client")?;
        Ok(Self {
            http,
            api,
            root: root.trim_end_matches('/').to_owned(),
            token,
            cache: Mutex::default(),
        })
    }

    /// End a refresh: forget answers to paths it didn't read.
    pub fn sweep(&self) {
        let mut cache = self.cache.lock().unwrap();
        cache.prev = std::mem::take(&mut cache.next);
    }

    fn cached(&self, key: &CacheKey) -> Option<(String, Value)> {
        let cache = self.cache.lock().unwrap();
        cache.next.get(key).or_else(|| cache.prev.get(key)).cloned()
    }
}

impl Source for Client {
    async fn get(&self, path: &str) -> Result<Value> {
        let token = self.token.token().await?;
        let key = CacheKey::new(path, &token);
        let cached = self.cached(&key);
        let mut req = self
            .http
            .get(format!("{}{path}", self.root))
            .header(USER_AGENT, "control-app");
        req = match self.api {
            Api::GitHub => req
                .header(AUTHORIZATION, format!("Bearer {token}"))
                .header(ACCEPT, "application/vnd.github+json")
                .header("X-GitHub-Api-Version", API_VERSION),
            Api::Forgejo => req
                .header(AUTHORIZATION, format!("token {token}"))
                .header(ACCEPT, "application/json"),
            Api::Kubernetes => req
                .header(AUTHORIZATION, format!("Bearer {token}"))
                .header(ACCEPT, "application/json"),
        };
        if let Some((etag, _)) = &cached {
            req = req.header(IF_NONE_MATCH, etag);
        }
        let mut resp = req.send().await.with_context(|| format!("GET {path}"))?;
        let status = resp.status();
        if status == StatusCode::NOT_MODIFIED {
            let Some((etag, value)) = cached else {
                bail!("GET {path}: HTTP 304 without a cached answer");
            };
            self.cache
                .lock()
                .unwrap()
                .next
                .insert(key, (etag, value.clone()));
            return Ok(value);
        }
        let etag = resp
            .headers()
            .get(ETAG)
            .and_then(|v: &HeaderValue| v.to_str().ok())
            .map(str::to_owned);
        // Count streamed bytes, not just Content-Length (which may be absent).
        // The same bound covers errors; never cache a truncated representation.
        let mut body = Vec::new();
        while let Some(chunk) = resp
            .chunk()
            .await
            .with_context(|| format!("GET {path}: reading the answer"))?
        {
            ensure!(
                chunk.len() <= MAX_BODY - body.len(),
                "GET {path}: response body exceeds {MAX_BODY} bytes"
            );
            body.extend_from_slice(&chunk);
        }
        if !status.is_success() {
            let message = serde_json::from_slice::<Value>(&body)
                .ok()
                .and_then(|v| v.get("message").and_then(Value::as_str).map(str::to_owned))
                .unwrap_or_else(|| String::from_utf8_lossy(&body).into_owned());
            bail!("GET {path}: HTTP {}: {message}", status.as_u16());
        }
        let value: Value = serde_json::from_slice(&body)
            .with_context(|| format!("GET {path}: reading the answer"))?;
        if let Some(etag) = etag {
            self.cache
                .lock()
                .unwrap()
                .next
                .insert(key, (etag, value.clone()));
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::Router;
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::IntoResponse;
    use axum::routing::get;

    use super::*;

    /// A GitHub that answers /thing with ETag "v1" and a 304 when asked with it, counting full answers.
    async fn fake_github(full: Arc<AtomicUsize>) -> String {
        let app = Router::new()
            .route(
                "/thing",
                get(move |headers: HeaderMap| async move {
                    if headers.get("if-none-match").is_some_and(|v| v == "\"v1\"") {
                        return StatusCode::NOT_MODIFIED.into_response();
                    }
                    full.fetch_add(1, Ordering::SeqCst);
                    (
                        [("etag", "\"v1\"")],
                        axum::Json(serde_json::json!({"n": 1})),
                    )
                        .into_response()
                }),
            )
            .route(
                "/auth",
                get(|headers: HeaderMap| async move {
                    axum::Json(serde_json::json!({
                        "authorization": headers["authorization"].to_str().unwrap(),
                        "api": headers.get("x-github-api-version").is_some(),
                    }))
                }),
            )
            .route(
                "/missing",
                get(|| async {
                    (
                        StatusCode::NOT_FOUND,
                        axum::Json(serde_json::json!({"message": "Not Found"})),
                    )
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn conditional_requests() {
        let full = Arc::new(AtomicUsize::new(0));
        let client = Client::new(
            TokenSource::Fixed("t".into()),
            &fake_github(full.clone()).await,
        )
        .unwrap();
        for _ in 0..3 {
            assert_eq!(
                client.get("/thing").await.unwrap(),
                serde_json::json!({"n": 1})
            );
            client.sweep();
        }
        assert_eq!(
            full.load(Ordering::SeqCst),
            1,
            "later reads are 304s served from the cache"
        );
        // Two refreshes without reading /thing forget it, so the next read is a full one.
        client.sweep();
        client.sweep();
        client.get("/thing").await.unwrap();
        assert_eq!(full.load(Ordering::SeqCst), 2);
        let err = client.get("/missing").await.unwrap_err().to_string();
        assert_eq!(err, "GET /missing: HTTP 404: Not Found");
    }

    #[tokio::test]
    async fn sends_each_api_its_token_scheme() {
        let root = fake_github(Arc::new(AtomicUsize::new(0))).await;
        let token = || TokenSource::Fixed("t".into());
        for (client, expected) in [
            (
                Client::new(token(), &root).unwrap(),
                serde_json::json!({"authorization": "Bearer t", "api": true}),
            ),
            (
                Client::forgejo(token(), &root).unwrap(),
                serde_json::json!({"authorization": "token t", "api": false}),
            ),
            (
                // Without the cluster's CA, which only an https root needs.
                Client::build(Api::Kubernetes, token().into(), &root, None).unwrap(),
                serde_json::json!({"authorization": "Bearer t", "api": false}),
            ),
        ] {
            assert_eq!(client.get("/auth").await.unwrap(), expected);
        }
    }

    #[tokio::test]
    async fn rotated_credentials_do_not_share_validators_or_bodies() {
        let hits = Arc::new(AtomicUsize::new(0));
        let seen = hits.clone();
        let app = Router::new()
            .route(
                "/scoped",
                get(move |headers: HeaderMap| {
                    let seen = seen.clone();
                    async move {
                        if headers[AUTHORIZATION]
                            .to_str()
                            .unwrap()
                            .ends_with(" refused")
                        {
                            return StatusCode::UNAUTHORIZED.into_response();
                        }
                        // Resource versions can coincide across credential-dependent
                        // representations. A validator alone is not an identity.
                        if headers.contains_key(IF_NONE_MATCH) {
                            seen.fetch_add(1, Ordering::SeqCst);
                            return StatusCode::NOT_MODIFIED.into_response();
                        }
                        (
                            [(ETAG, "\"same-version\"")],
                            axum::Json(serde_json::json!({
                                "authorization": headers[AUTHORIZATION].to_str().unwrap(),
                            })),
                        )
                            .into_response()
                    }
                }),
            )
            .route("/unsolicited", get(|| async { StatusCode::NOT_MODIFIED }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let root = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        for api in [Api::GitHub, Api::Forgejo, Api::Kubernetes] {
            let before = hits.load(Ordering::SeqCst);
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("token");
            let client =
                Client::build(api, Arc::new(TokenSource::File(path.clone())), &root, None).unwrap();
            let scheme = if api == Api::Forgejo {
                "token"
            } else {
                "Bearer"
            };
            for token in ["first", "first", "second", "second", "first"] {
                tokio::fs::write(&path, token).await.unwrap();
                let value = client.get("/scoped").await.unwrap();
                assert_eq!(
                    value["authorization"],
                    format!("{scheme} {token}"),
                    "{api:?}"
                );
                client.sweep();
            }
            // A cache miss must not accept an unsolicited 304 either.
            client.sweep();
            client.sweep();
            assert_eq!(
                client.get("/scoped").await.unwrap()["authorization"],
                format!("{scheme} first")
            );
            assert!(
                client
                    .get("/unsolicited")
                    .await
                    .unwrap_err()
                    .to_string()
                    .contains("304 without a cached answer")
            );
            // An expired/revoked replacement must fail, not serve old facts.
            tokio::fs::write(&path, "refused").await.unwrap();
            assert!(
                client
                    .get("/scoped")
                    .await
                    .unwrap_err()
                    .to_string()
                    .contains("HTTP 401")
            );
            assert_eq!(
                hits.load(Ordering::SeqCst) - before,
                2,
                "{api:?}: unchanged credentials still revalidate; rotation and cache loss read full bodies"
            );
        }
    }

    #[tokio::test]
    async fn late_response_stays_in_its_requests_credential_scope() {
        let started = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let signals = (started.clone(), release.clone());
        let app = Router::new().route(
            "/scoped",
            get(move |headers: HeaderMap| {
                let (started, release) = signals.clone();
                async move {
                    if headers.contains_key(IF_NONE_MATCH) {
                        return StatusCode::NOT_MODIFIED.into_response();
                    }
                    let auth = headers[AUTHORIZATION].to_str().unwrap();
                    if auth == "Bearer first" {
                        started.notify_one();
                        release.notified().await;
                    }
                    (
                        [(ETAG, "\"same-version\"")],
                        axum::Json(serde_json::json!({"authorization": auth})),
                    )
                        .into_response()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let root = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("token");
        tokio::fs::write(&path, "first").await.unwrap();
        let client = Arc::new(Client::new(TokenSource::File(path.clone()), &root).unwrap());
        let old = client.clone();
        let old = tokio::spawn(async move { old.get("/scoped").await.unwrap() });
        tokio::time::timeout(Duration::from_secs(5), started.notified())
            .await
            .unwrap();
        tokio::fs::write(&path, "second").await.unwrap();
        assert_eq!(
            client.get("/scoped").await.unwrap()["authorization"],
            "Bearer second"
        );
        release.notify_one();
        assert_eq!(old.await.unwrap()["authorization"], "Bearer first");
        client.sweep();
        assert_eq!(
            client.get("/scoped").await.unwrap()["authorization"],
            "Bearer second"
        );
    }

    #[test]
    fn kubernetes_needs_a_ca() {
        let err = Client::kubernetes(TokenSource::Fixed("t".into()), "https://k", b"")
            .err()
            .unwrap();
        assert_eq!(err.to_string(), "the CA has no certificate");
    }

    #[tokio::test]
    async fn response_body_bound() {
        use axum::body::{Body, Bytes};
        use axum::extract::Path;

        let app = Router::new().route(
            "/{status}/{size}/{streamed}",
            get(
                |Path((status, size, streamed)): Path<(u16, usize, bool)>| async move {
                    // Valid JSON exactly `size` bytes long, also on the error path.
                    let json = format!("\"{}\"", "x".repeat(size - 2));
                    let body = if streamed {
                        let chunks: Vec<_> = json
                            .as_bytes()
                            .chunks(8192)
                            .map(|b| Ok::<_, std::io::Error>(Bytes::copy_from_slice(b)))
                            .collect();
                        Body::from_stream(futures_util::stream::iter(chunks))
                    } else {
                        Body::from(json)
                    };
                    (
                        StatusCode::from_u16(status).unwrap(),
                        [(ETAG, "\"v1\"")],
                        body,
                    )
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let root = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        for api in [Api::GitHub, Api::Forgejo, Api::Kubernetes] {
            let client =
                Client::build(api, Arc::new(TokenSource::Fixed("t".into())), &root, None).unwrap();
            for streamed in [false, true] {
                let path = format!("/200/{MAX_BODY}/{streamed}");
                assert_eq!(
                    client.get(&path).await.unwrap().as_str().unwrap().len(),
                    MAX_BODY - 2
                );
                assert!(client.cached(&CacheKey::new(&path, "t")).is_some());
                for status in [200, 500] {
                    let path = format!("/{status}/{}/{streamed}", MAX_BODY + 1);
                    let err = client.get(&path).await.unwrap_err().to_string();
                    assert_eq!(
                        err,
                        format!("GET {path}: response body exceeds {MAX_BODY} bytes"),
                        "{api:?}"
                    );
                    assert!(client.cached(&CacheKey::new(&path, "t")).is_none());
                }
            }
        }
        server.abort();
    }

    #[tokio::test]
    async fn oversized_refresh_does_not_replace_cached_answer() {
        let reads = Arc::new(AtomicUsize::new(0));
        let app = Router::new().route(
            "/thing",
            get(move |headers: HeaderMap| {
                let read = reads.fetch_add(1, Ordering::SeqCst);
                async move {
                    if read == 0 {
                        assert!(!headers.contains_key(IF_NONE_MATCH));
                        return ([(ETAG, "\"old\"")], "{\"n\":1}").into_response();
                    }
                    assert_eq!(headers[IF_NONE_MATCH], "\"old\"");
                    if read == 1 {
                        ([(ETAG, "\"oversized\"")], "x".repeat(MAX_BODY + 1)).into_response()
                    } else {
                        StatusCode::NOT_MODIFIED.into_response()
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let root = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = Client::new(TokenSource::Fixed("t".into()), &root).unwrap();
        let original = client.get("/thing").await.unwrap();
        client.sweep();
        assert!(
            client
                .get("/thing")
                .await
                .unwrap_err()
                .to_string()
                .contains("response body exceeds")
        );
        assert!(client.cache.lock().unwrap().next.is_empty());
        assert_eq!(client.get("/thing").await.unwrap(), original);
        server.abort();
    }
}
