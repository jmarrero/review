//! Where the GitHub token comes from. Never a flag or environment value,
//! which leak into process listings and crash reports: a file, reread for
//! every request so a rotated Secret takes effect; an Octo STS exchange of
//! the pod's service-account token for a short-lived installation token;
//! or, for local runs, `gh auth token`.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail, ensure};
use reqwest::header::{AUTHORIZATION, USER_AGENT};
use serde::Deserialize;
use tokio::io::AsyncReadExt;
use tokio::sync::Mutex;

pub const OCTO_STS_ROOT: &str = "https://octo-sts.dev";

/// GitHub installation tokens last an hour; exchange again well before.
const OCTO_STS_REFRESH: Duration = Duration::from_secs(45 * 60);

/// Give up on an exchange Octo STS hasn't answered in this long.
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(30);

// Token acquisition is part of a preview's read budget too. A faulty STS
// response must not exhaust memory before the bounded forge reads even start.
const MAX_EXCHANGE_BODY: usize = 64 * 1024;

// A mis-mounted or growing token file must not bypass the preview's memory
// bounds. Count raw bytes, including whitespace, before decoding or trimming.
const MAX_TOKEN_FILE: usize = 64 * 1024;

pub enum TokenSource {
    /// A token read once at startup, from `gh auth token`.
    Fixed(String),
    /// A file holding the token, reread for every request.
    File(PathBuf),
    OctoSts(OctoSts),
}

impl TokenSource {
    /// The local convenience: the token `gh` holds for github.com.
    pub fn gh() -> Result<Self> {
        let out = std::process::Command::new("gh")
            .args(["auth", "token", "--hostname", "github.com"])
            .output()
            .context("no token source given, and running `gh auth token` failed")?;
        let t = String::from_utf8(out.stdout).unwrap_or_default();
        if !out.status.success() || t.trim().is_empty() {
            bail!("no token source given, and `gh auth token` gave none");
        }
        Ok(Self::Fixed(t.trim().to_owned()))
    }

    pub async fn token(&self) -> Result<String> {
        match self {
            Self::Fixed(t) => Ok(t.clone()),
            Self::File(path) => read_token(path).await,
            Self::OctoSts(sts) => sts.token().await,
        }
    }
}

/// A token file's bounded, trimmed UTF-8 contents, which must not be empty.
async fn read_token(path: &PathBuf) -> Result<String> {
    // A FIFO open can outlive cancellation of the async read and keep Tokio's
    // blocking pool alive at shutdown. Check the opened descriptor so mounted
    // secret symlinks work without a path-replacement race.
    let file = tokio::fs::OpenOptions::new()
        .read(true)
        .custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32)
        .open(path)
        .await
        .with_context(|| format!("reading the token from {}", path.display()))?;
    ensure!(
        file.metadata()
            .await
            .context("checking token file")?
            .is_file(),
        "token file must be a regular file"
    );
    let mut bytes = Vec::new();
    file.take((MAX_TOKEN_FILE + 1) as u64)
        .read_to_end(&mut bytes)
        .await
        .with_context(|| format!("reading the token from {}", path.display()))?;
    ensure!(
        bytes.len() <= MAX_TOKEN_FILE,
        "token file exceeds {MAX_TOKEN_FILE} bytes"
    );
    let t = String::from_utf8(bytes).context("token file is not UTF-8")?;
    let t = t.trim();
    if t.is_empty() {
        bail!("{} holds no token", path.display());
    }
    Ok(t.to_owned())
}

/// Exchanges a Kubernetes service-account token (audience octo-sts.dev)
/// at Octo STS for an installation token whose permissions the trust
/// policy `identity` in `scope` grants (service/README.md).
pub struct OctoSts {
    http: reqwest::Client,
    root: String,
    scope: String,
    identity: String,
    /// The projected service-account token, which the kubelet rotates:
    /// read again for every exchange.
    oidc_token_file: PathBuf,
    refresh_after: Duration,
    /// The last installation token and when it was issued. Behind an async
    /// lock, so concurrent requests share one exchange.
    current: Mutex<Option<(String, Instant)>>,
}

#[derive(Deserialize)]
struct Exchanged {
    token: Option<String>,
    message: Option<String>,
}

impl OctoSts {
    pub fn new(
        root: &str,
        scope: String,
        identity: String,
        oidc_token_file: PathBuf,
    ) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(EXCHANGE_TIMEOUT)
            // Even same-origin redirects must not forward the OIDC bearer to
            // another path or let that path supply the installation token.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .context("building the HTTP client")?;
        Ok(Self {
            http,
            root: root.trim_end_matches('/').to_owned(),
            scope,
            identity,
            oidc_token_file,
            refresh_after: OCTO_STS_REFRESH,
            current: Mutex::new(None),
        })
    }

    async fn token(&self) -> Result<String> {
        let mut current = self.current.lock().await;
        if let Some((t, at)) = &*current
            && at.elapsed() < self.refresh_after
        {
            return Ok(t.clone());
        }
        let t = self.exchange().await.with_context(|| {
            format!(
                "exchanging the service-account token at Octo STS for {} {}",
                self.scope, self.identity
            )
        })?;
        *current = Some((t.clone(), Instant::now()));
        Ok(t)
    }

    async fn exchange(&self) -> Result<String> {
        let oidc = read_token(&self.oidc_token_file).await?;
        let url = reqwest::Url::parse_with_params(
            &format!("{}/sts/exchange", self.root),
            [("scope", &self.scope), ("identity", &self.identity)],
        )
        .context("building the exchange URL")?;
        let mut resp = self
            .http
            .get(url)
            .header(AUTHORIZATION, format!("Bearer {oidc}"))
            .header(USER_AGENT, "control-app")
            .send()
            .await?;
        let status = resp.status();
        ensure!(
            !status.is_redirection(),
            "HTTP {}: Octo STS redirects are not allowed",
            status.as_u16()
        );
        let mut body = Vec::new();
        while let Some(chunk) = resp.chunk().await.context("reading the answer")? {
            ensure!(
                chunk.len() <= MAX_EXCHANGE_BODY - body.len(),
                "Octo STS response exceeds {MAX_EXCHANGE_BODY} bytes"
            );
            body.extend_from_slice(&chunk);
        }
        let answer = serde_json::from_slice::<Exchanged>(&body).ok();
        match answer {
            Some(Exchanged { token: Some(t), .. }) if status.is_success() && !t.is_empty() => Ok(t),
            Some(Exchanged {
                message: Some(m), ..
            }) => bail!("HTTP {}: {m}", status.as_u16()),
            _ => bail!(
                "HTTP {}: no token in {:?}",
                status.as_u16(),
                String::from_utf8_lossy(&body)
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::Router;
    use axum::extract::Query;
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::IntoResponse;
    use axum::routing::get;
    use serde_json::json;

    use super::*;

    /// An Octo STS that answers each exchange with "installation-N" for the
    /// bearer token "oidc-N"'s N, and refuses others.
    async fn fake_sts(exchanges: Arc<AtomicUsize>) -> String {
        let app = Router::new().route(
            "/sts/exchange",
            get(
                move |headers: HeaderMap, Query(q): Query<Vec<(String, String)>>| async move {
                    exchanges.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(
                        q,
                        [
                            ("scope".to_owned(), "jmarrero-forge".to_owned()),
                            ("identity".to_owned(), "control-plane".to_owned())
                        ]
                    );
                    let bearer = headers["authorization"].to_str().unwrap();
                    match bearer.strip_prefix("Bearer oidc-") {
                        Some(n) => axum::Json(json!({"token": format!("installation-{n}")}))
                            .into_response(),
                        None => (
                            StatusCode::FORBIDDEN,
                            axum::Json(json!({"message": "no matching trust policy"})),
                        )
                            .into_response(),
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("review-service-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("token")
    }

    #[tokio::test]
    async fn token_files_require_regular_files_and_follow_rotated_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("token");
        let link = dir.path().join("mounted-token");
        std::fs::write(&file, "fixture-one\n").unwrap();
        std::os::unix::fs::symlink(&file, &link).unwrap();
        let source = TokenSource::File(link.clone());
        assert_eq!(source.token().await.unwrap(), "fixture-one");
        let replacement = dir.path().join("rotated-token");
        std::fs::write(&replacement, "fixture-two\n").unwrap();
        std::fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink(&replacement, &link).unwrap();
        assert_eq!(source.token().await.unwrap(), "fixture-two");

        for path in [dir.path().to_path_buf(), PathBuf::from("/dev/null")] {
            assert_eq!(
                read_token(&path).await.unwrap_err().to_string(),
                "token file must be a regular file"
            );
        }
    }

    #[tokio::test]
    async fn octo_sts_rereads_the_oidc_token_and_caches() {
        let exchanges = Arc::new(AtomicUsize::new(0));
        let root = fake_sts(exchanges.clone()).await;
        let file = scratch("sts");
        std::fs::write(&file, "oidc-1\n").unwrap();
        let source = |refresh_after| {
            let mut sts = OctoSts::new(
                &root,
                "jmarrero-forge".into(),
                "control-plane".into(),
                file.clone(),
            )
            .unwrap();
            sts.refresh_after = refresh_after;
            TokenSource::OctoSts(sts)
        };

        // Within the refresh period, one exchange serves every request.
        let cached = source(OCTO_STS_REFRESH);
        assert_eq!(cached.token().await.unwrap(), "installation-1");
        std::fs::write(&file, "oidc-2").unwrap();
        assert_eq!(cached.token().await.unwrap(), "installation-1");
        assert_eq!(exchanges.load(Ordering::SeqCst), 1);

        // Past it, each exchange reads the rotated service-account token.
        let expiring = source(Duration::ZERO);
        assert_eq!(expiring.token().await.unwrap(), "installation-2");
        std::fs::write(&file, "oidc-3").unwrap();
        assert_eq!(expiring.token().await.unwrap(), "installation-3");
        assert_eq!(exchanges.load(Ordering::SeqCst), 3);

        std::fs::write(&file, "stolen").unwrap();
        let err = format!("{:#}", expiring.token().await.unwrap_err());
        assert!(
            err.ends_with("jmarrero-forge control-plane: HTTP 403: no matching trust policy"),
            "{err}"
        );
        std::fs::write(&file, "").unwrap();
        let err = format!("{:#}", expiring.token().await.unwrap_err());
        assert!(err.ends_with("holds no token"), "{err}");
        std::fs::remove_dir_all(file.parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn octo_sts_refuses_redirects_without_contacting_the_target() {
        for status in [301, 302, 303, 307, 308] {
            for same_origin in [true, false] {
                let targets = Arc::new(AtomicUsize::new(0));
                let seen = targets.clone();
                let target = Router::new().route(
                    "/redirect-target",
                    get(move || {
                        seen.fetch_add(1, Ordering::SeqCst);
                        async { axum::Json(json!({"token": "redirected-token"})) }
                    }),
                );
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let target_url =
                    format!("http://{}/redirect-target", listener.local_addr().unwrap());
                let other_target = target.clone();
                let other_server =
                    tokio::spawn(async move { axum::serve(listener, other_target).await.unwrap() });
                let calls = Arc::new(AtomicUsize::new(0));
                let seen = calls.clone();
                let app = target.route(
                    "/sts/exchange",
                    get(move |headers: HeaderMap| {
                        let attempt = seen.fetch_add(1, Ordering::SeqCst);
                        let location = if same_origin {
                            "/redirect-target".to_owned()
                        } else {
                            target_url.clone()
                        };
                        async move {
                            assert_eq!(headers["authorization"], "Bearer fixture-oidc");
                            if attempt == 0 {
                                (
                                    StatusCode::from_u16(status).unwrap(),
                                    [("location", location)],
                                    axum::Json(json!({"token": "redirect-body-token"})),
                                )
                                    .into_response()
                            } else {
                                axum::Json(json!({"token": "direct-token"})).into_response()
                            }
                        }
                    }),
                );
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let root = format!("http://{}", listener.local_addr().unwrap());
                let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
                let dir = tempfile::tempdir().unwrap();
                let file = dir.path().join("token");
                std::fs::write(&file, "fixture-oidc").unwrap();
                let sts = OctoSts::new(&root, "example".into(), "preview".into(), file).unwrap();

                let result = sts.token().await;
                assert_eq!(targets.load(Ordering::SeqCst), 0, "HTTP {status}");
                let error = format!("{:#}", result.unwrap_err());
                assert!(error.contains(&format!("HTTP {status}")), "{error}");
                assert!(!error.contains("redirect-body-token"));
                assert!(!error.contains("redirect-target"));
                assert!(sts.current.lock().await.is_none());
                // A later direct exchange can recover; only its token is cached.
                assert_eq!(sts.token().await.unwrap(), "direct-token");
                assert_eq!(sts.token().await.unwrap(), "direct-token");
                assert_eq!(calls.load(Ordering::SeqCst), 2);
                server.abort();
                other_server.abort();
            }
        }
    }

    #[tokio::test]
    async fn octo_sts_bounds_streamed_answers_before_caching() {
        use axum::body::Body;
        use futures_util::stream;

        for status in [StatusCode::OK, StatusCode::BAD_GATEWAY] {
            for streamed in [false, true] {
                let calls = Arc::new(AtomicUsize::new(0));
                let seen = calls.clone();
                let app = Router::new().route(
                    "/sts/exchange",
                    get(move || {
                        let attempt = seen.fetch_add(1, Ordering::SeqCst);
                        async move {
                            // A valid token followed by JSON whitespace: parsing
                            // before counting the entire body would cache it.
                            let mut body = br#"{"token":"installation-bounded"}"#.to_vec();
                            body.resize(MAX_EXCHANGE_BODY + usize::from(attempt == 0), b' ');
                            let body = if streamed {
                                Body::from_stream(stream::iter(
                                    body.chunks(1024)
                                        .map(|c| Ok::<_, std::io::Error>(c.to_vec()))
                                        .collect::<Vec<_>>(),
                                ))
                            } else {
                                Body::from(body)
                            };
                            (if attempt == 0 { status } else { StatusCode::OK }, body)
                        }
                    }),
                );
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let root = format!("http://{}", listener.local_addr().unwrap());
                let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
                let dir = tempfile::tempdir().unwrap();
                let file = dir.path().join("token");
                std::fs::write(&file, "fixture-oidc").unwrap();
                let sts = OctoSts::new(&root, "example".into(), "preview".into(), file).unwrap();
                let error = format!("{:#}", sts.token().await.unwrap_err());
                assert!(
                    error.contains("Octo STS response exceeds 65536 bytes"),
                    "{error}"
                );
                assert!(!error.contains("installation-bounded"));
                assert!(sts.current.lock().await.is_none());
                // The exact bound is accepted on recovery, then cached normally.
                assert_eq!(sts.token().await.unwrap(), "installation-bounded");
                assert_eq!(sts.token().await.unwrap(), "installation-bounded");
                assert_eq!(calls.load(Ordering::SeqCst), 2);
                server.abort();
            }
        }
    }

    #[tokio::test]
    async fn token_files_are_bounded_before_trimming_and_recover_after_rotation() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("token");
        let source = TokenSource::File(file.clone());
        let mut padded = b"fixture-token".to_vec();
        padded.resize(MAX_TOKEN_FILE, b' ');
        std::fs::write(&file, &padded).unwrap();
        assert_eq!(source.token().await.unwrap(), "fixture-token");

        padded.push(b' ');
        std::fs::write(&file, &padded).unwrap();
        let error = format!("{:#}", source.token().await.unwrap_err());
        assert_eq!(error, "token file exceeds 65536 bytes");
        assert!(!error.contains("fixture-token"));

        // Multibyte input is counted in bytes, not characters.
        std::fs::write(&file, "é".repeat(MAX_TOKEN_FILE / 2 + 1)).unwrap();
        assert!(
            source
                .token()
                .await
                .unwrap_err()
                .to_string()
                .contains("exceeds")
        );
        for invalid in [b" \n\t".as_slice(), &[0xff]] {
            std::fs::write(&file, invalid).unwrap();
            assert!(source.token().await.is_err());
        }
        std::fs::write(&file, " rotated-token\n").unwrap();
        assert_eq!(source.token().await.unwrap(), "rotated-token");
    }

    #[tokio::test]
    async fn oversized_oidc_file_prevents_exchange_and_recovers() {
        let exchanges = Arc::new(AtomicUsize::new(0));
        let root = fake_sts(exchanges.clone()).await;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("token");
        let mut sts = OctoSts::new(
            &root,
            "jmarrero-forge".into(),
            "control-plane".into(),
            file.clone(),
        )
        .unwrap();
        sts.refresh_after = Duration::ZERO;
        std::fs::write(&file, "oidc-1").unwrap();
        assert_eq!(sts.token().await.unwrap(), "installation-1");

        std::fs::write(&file, vec![b'x'; MAX_TOKEN_FILE + 1]).unwrap();
        let error = format!("{:#}", sts.token().await.unwrap_err());
        assert!(error.ends_with("token file exceeds 65536 bytes"), "{error}");
        assert_eq!(exchanges.load(Ordering::SeqCst), 1);

        std::fs::write(&file, "oidc-2").unwrap();
        assert_eq!(sts.token().await.unwrap(), "installation-2");
        assert_eq!(exchanges.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn file_is_reread() {
        let file = scratch("file");
        let src = TokenSource::File(file.clone());
        assert!(src.token().await.is_err(), "a missing file is an error");
        std::fs::write(&file, " one\n").unwrap();
        assert_eq!(src.token().await.unwrap(), "one");
        std::fs::write(&file, "two").unwrap();
        assert_eq!(src.token().await.unwrap(), "two");
        std::fs::remove_dir_all(file.parent().unwrap()).unwrap();
    }
}
