//! control-app: builds the control app's state from GitHub queries on
//! a timer and serves it with the app, plus opt-in ACP attachments.
//! See service/README.md.

mod acp;
mod board;
mod forgejo;
mod github;
mod kubernetes;
mod server;
mod state;
mod token;
mod version;

use std::io::Write;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result, bail};
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::watch;

use crate::github::Client;
use crate::state::State;
use crate::token::{OctoSts, TokenSource};

const USAGE: &str = "Usage: control-app [OPTION...]

Build the control app's state from GitHub queries every --interval
seconds and serve it read-only: /api/state, /api/repos/OWNER/REPO,
/api/events (server-sent events) and /healthz, with the built app at /.

  --listen ADDR            where to listen (default 0.0.0.0:8080)
  --allow-host NAME        a host name requests may use besides localhost
                           and IP addresses, such as the proxy's; repeatable
  --static DIR             the built app to serve (default dist)
  --interval SECONDS       refresh period, 30 to 3600 (default 60)
  --board-config PATH      opt in to one bounded board-forge preview per refresh
  --board-once PATH        print one board preview as state JSON and exit;
                           accepts only token options, never starts a server
  --acp-config PATH        opt in to configured session WebSocket attachments

The GitHub token, which needs only read access, comes from one of:

  --github-token-file PATH  a file holding it, reread for every request
                            (default $GITHUB_TOKEN_FILE)
  --octo-sts-scope OWNER[/REPO] --octo-sts-identity NAME
  --octo-sts-token-file PATH
                            an Octo STS exchange of the service-account
                            token in PATH (audience octo-sts.dev) for an
                            installation token, under trust policy NAME
  (none of these)           `gh auth token`, for local runs

A Forgejo section, off unless --forgejo-url is given, reads with GETs:

  --forgejo-url URL         the instance's base URL
  --forgejo-token-file PATH a file holding its read-only token, reread
                            for every request
  --forgejo-org ORG         an organization to search for labeled open
                            issues, with --forgejo-label; repeatable (10)
  --forgejo-label LABEL     a label those issues carry, any of them;
                            repeatable (20)
  --forgejo-reviewer USER   the token's user, whose requested reviews on
                            open PRs are read

A Kubernetes section, off unless a namespace is given, lists with GETs
the cluster's Flux Kustomizations, Deployments, and crash-looping,
restarting or pending pods, using in-cluster config:

  --kubernetes-namespace NS a namespace to list in; repeatable (10)
";

const DEFAULT_LISTEN: &str = "0.0.0.0:8080";

const DEFAULT_STATIC: &str = "dist";

const TOKEN_FILE_ENV: &str = "GITHUB_TOKEN_FILE";

/// Each refresh makes three searches, and search allows 30 a minute.
const INTERVAL_SECS: std::ops::RangeInclusive<u64> = 30..=3600;

const DEFAULT_INTERVAL_SECS: u64 = 60;

#[derive(Debug, PartialEq)]
enum TokenConfig {
    Gh,
    File(PathBuf),
    OctoSts {
        scope: String,
        identity: String,
        token_file: PathBuf,
    },
}

struct Args {
    listen: SocketAddr,
    allowed_hosts: Vec<String>,
    static_dir: PathBuf,
    interval: Duration,
    token: TokenConfig,
    board_config: Option<PathBuf>,
    board_once: bool,
    acp_config: Option<PathBuf>,
    forgejo: Option<forgejo::Config>,
    kubernetes: Option<kubernetes::Config>,
}

/// The arguments, with `token_file_env` the value of $GITHUB_TOKEN_FILE.
fn parse_args(
    mut args: impl Iterator<Item = String>,
    token_file_env: Option<String>,
) -> Result<Option<Args>> {
    let mut listen = DEFAULT_LISTEN.to_owned();
    let mut allowed_hosts = Vec::new();
    let mut static_dir = PathBuf::from(DEFAULT_STATIC);
    let mut interval = DEFAULT_INTERVAL_SECS;
    let mut token_file = token_file_env.filter(|f| !f.is_empty());
    let mut board_config = None;
    let mut board_once = false;
    let mut service_options = false;
    let mut acp_config = None;
    let (mut forgejo_url, mut forgejo_token_file, mut forgejo_reviewer) = (None, None, None);
    let (mut forgejo_orgs, mut forgejo_labels) = (Vec::new(), Vec::new());
    let mut kubernetes_namespaces = Vec::new();
    let (mut sts_scope, mut sts_identity, mut sts_token_file) = (None, None, None);
    while let Some(a) = args.next() {
        let (flag, inline) = match a.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f.to_owned(), Some(v.to_owned())),
            _ => (a.clone(), None),
        };
        if flag == "-h" || flag == "--help" {
            return Ok(None);
        }
        let Some(value) = inline.or_else(|| args.next()) else {
            bail!("{flag} needs a value");
        };
        service_options |= !matches!(
            flag.as_str(),
            "--board-once"
                | "--github-token-file"
                | "--octo-sts-scope"
                | "--octo-sts-identity"
                | "--octo-sts-token-file"
        );
        match flag.as_str() {
            "--listen" => listen = value,
            "--allow-host" => allowed_hosts.push(value),
            "--static" => static_dir = value.into(),
            "--board-config" => board_config = Some(value.into()),
            "--board-once" => {
                board_once = true;
                board_config = Some(value.into());
            }
            "--acp-config" => acp_config = Some(value.into()),
            "--interval" => {
                interval = value
                    .parse()
                    .with_context(|| format!("--interval {value:?} is not a number of seconds"))?
            }
            "--github-token-file" => token_file = Some(value),
            "--octo-sts-scope" => sts_scope = Some(value),
            "--octo-sts-identity" => sts_identity = Some(value),
            "--octo-sts-token-file" => sts_token_file = Some(value),
            "--forgejo-url" => forgejo_url = Some(value),
            "--forgejo-token-file" => forgejo_token_file = Some(value.into()),
            "--forgejo-org" => forgejo_orgs.push(value),
            "--forgejo-label" => forgejo_labels.push(value),
            "--forgejo-reviewer" => forgejo_reviewer = Some(value),
            "--kubernetes-namespace" => kubernetes_namespaces.push(value),
            _ => bail!("unknown option {flag:?}"),
        }
    }
    if board_once && service_options {
        bail!("--board-once accepts only GitHub token options");
    }
    if !INTERVAL_SECS.contains(&interval) {
        bail!(
            "--interval must be {} to {} seconds",
            INTERVAL_SECS.start(),
            INTERVAL_SECS.end()
        );
    }
    let listen = listen
        .parse()
        .with_context(|| format!("--listen {listen:?} is not an address and port"))?;
    let token = match (sts_scope, sts_identity, sts_token_file) {
        (None, None, None) => match token_file {
            Some(f) => TokenConfig::File(f.into()),
            None => TokenConfig::Gh,
        },
        (Some(scope), Some(identity), Some(file)) => {
            if token_file.is_some() {
                bail!("give either a token file or Octo STS, not both");
            }
            TokenConfig::OctoSts {
                scope,
                identity,
                token_file: file.into(),
            }
        }
        _ => bail!(
            "Octo STS needs all of --octo-sts-scope, --octo-sts-identity and --octo-sts-token-file"
        ),
    };
    let forgejo = match forgejo_url {
        Some(url) => Some(forgejo::Config::new(
            &url,
            forgejo_token_file,
            forgejo_orgs,
            forgejo_labels,
            forgejo_reviewer,
        )?),
        None if forgejo_token_file.is_some()
            || forgejo_reviewer.is_some()
            || !forgejo_orgs.is_empty()
            || !forgejo_labels.is_empty() =>
        {
            bail!("the --forgejo-* options need --forgejo-url")
        }
        None => None,
    };
    let kubernetes = if kubernetes_namespaces.is_empty() {
        None
    } else {
        Some(kubernetes::Config::new(kubernetes_namespaces)?)
    };
    Ok(Some(Args {
        listen,
        allowed_hosts,
        static_dir,
        interval: Duration::from_secs(interval),
        token,
        board_config,
        board_once,
        acp_config,
        forgejo,
        kubernetes,
    }))
}

fn token_source(config: TokenConfig) -> Result<TokenSource> {
    Ok(match config {
        TokenConfig::Gh => TokenSource::gh()?,
        TokenConfig::File(path) => TokenSource::File(path),
        TokenConfig::OctoSts {
            scope,
            identity,
            token_file,
        } => TokenSource::OctoSts(OctoSts::new(
            token::OCTO_STS_ROOT,
            scope,
            identity,
            token_file,
        )?),
    })
}

fn now() -> String {
    humantime::format_rfc3339_seconds(SystemTime::now()).to_string()
}

/// The same decision envelope as HTTP/SSE, without unrelated source reads or
/// a listener. Unread sections remain explicitly incomplete, not empty success.
async fn preview_once(reader: &board::Reader, clock: impl Fn() -> String) -> State {
    let mut state = State::empty();
    state.generation = 1;
    state.decision = Some(reader.refresh(None, &clock()).await);
    state.decision_refresh = Some(reader.status());
    state.refreshed_at = Some(clock());
    state
}

fn write_preview(state: &State, mut output: impl Write) -> Result<()> {
    serde_json::to_writer(&mut output, state).context("writing board preview")?;
    writeln!(output).context("writing board preview")?;
    output.flush().context("writing board preview")?;
    if !state
        .decision
        .as_ref()
        .is_some_and(|d| d.complete && d.error.is_none())
    {
        bail!("board preview incomplete; inspect the emitted decision section");
    }
    Ok(())
}

/// Compute one whole generation before the watch channel exposes any of it.
/// Each source gets its own observation clock; publication is not validation.
async fn refresh_generation<S: github::Source, F: github::Source, K: github::Source>(
    client: &S,
    board: Option<&board::Reader>,
    forgejo: Option<(&F, &forgejo::Config)>,
    kubernetes: Option<(&K, &kubernetes::Config)>,
    prev: &State,
    clock: impl Fn() -> String,
) -> State {
    let at = clock();
    // Forgejo and Kubernetes are read alongside GitHub, so a slow one delays
    // the publication of GitHub's sections by its own reads at most.
    let forgejo_read = async {
        match forgejo {
            Some((src, config)) => {
                Some(forgejo::refresh(src, config, prev.forgejo.as_ref(), &clock()).await)
            }
            None => None,
        }
    };
    let kubernetes_read = async {
        match kubernetes {
            Some((src, config)) => {
                Some(kubernetes::refresh(src, config, prev.kubernetes.as_ref(), &clock()).await)
            }
            None => None,
        }
    };
    let (mut next, forgejo_section, kubernetes_section) = tokio::join!(
        state::refresh(client, prev, &at),
        forgejo_read,
        kubernetes_read
    );
    next.forgejo = forgejo_section;
    next.kubernetes = kubernetes_section;
    if let Some(board) = board {
        next.decision = Some(board.refresh(prev.decision.as_ref(), &clock()).await);
        next.decision_refresh = Some(board.status());
    }
    next.refreshed_at = Some(clock());
    next
}

/// Refresh the state every `interval`, publishing each result.
async fn refresher(
    client: Client,
    board: Option<board::Reader>,
    forgejo: Option<(Client, forgejo::Config)>,
    kubernetes: Option<(Client, kubernetes::Config)>,
    tx: watch::Sender<Arc<State>>,
    interval: Duration,
) {
    periodic(interval, || async {
        let prev = tx.borrow().clone();
        let forgejo_ref = forgejo.as_ref().map(|(c, config)| (c, config));
        let kubernetes_ref = kubernetes.as_ref().map(|(c, config)| (c, config));
        let next = refresh_generation(
            &client,
            board.as_ref(),
            forgejo_ref,
            kubernetes_ref,
            &prev,
            now,
        )
        .await;
        for c in std::iter::once(&client)
            .chain(forgejo.iter().map(|(c, _)| c))
            .chain(kubernetes.iter().map(|(c, _)| c))
        {
            c.sweep();
        }
        let forgejo_error = next.forgejo.as_ref().and_then(|s| s.error.as_ref());
        let kubernetes_error = next.kubernetes.as_ref().and_then(|s| s.error.as_ref());
        for (name, error) in [
            ("runs", next.runs.error.as_ref()),
            ("prs", next.prs.error.as_ref()),
            ("waiting", next.waiting.error.as_ref()),
            ("forgejo", forgejo_error),
            ("kubernetes", kubernetes_error),
        ] {
            if let Some(e) = error {
                println!("control-app: {name}: {e}");
            }
        }
        tx.send_replace(Arc::new(next));
    })
    .await;
}

/// One serialized loop, initially ready, then spaced from completion. Dropping
/// it drops the active refresh; slow passes never accumulate catch-up work.
async fn periodic<F: Future<Output = ()>>(interval: Duration, mut refresh: impl FnMut() -> F) {
    loop {
        refresh().await;
        tokio::time::sleep(interval).await;
    }
}

/// SIGTERM, as Kubernetes sends, or ^C.
async fn terminated() -> Result<()> {
    let mut term = signal(SignalKind::terminate()).context("handling SIGTERM")?;
    tokio::select! {
        _ = term.recv() => {}
        r = tokio::signal::ctrl_c() => r.context("handling ^C")?,
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let Some(args) = parse_args(std::env::args().skip(1), std::env::var(TOKEN_FILE_ENV).ok())
        .inspect_err(|_| eprint!("{USAGE}"))?
    else {
        print!("{USAGE}");
        return Ok(());
    };
    let acp = match args.acp_config {
        Some(path) => Some(acp::Bridge::load(&path).await?),
        None => None,
    };
    let token = Arc::new(token_source(args.token)?);
    let board = match args.board_config {
        Some(path) => Some(board::Reader::new(&path, token.clone()).await?),
        None => None,
    };
    if args.board_once {
        let reader = board.context("--board-once requires board configuration")?;
        let state = tokio::select! {
            state = preview_once(&reader, now) => state,
            result = terminated() => {
                result?;
                bail!("board preview interrupted");
            }
        };
        return write_preview(&state, std::io::stdout().lock());
    }
    let client = Client::new(token, github::API_ROOT)?;
    let forgejo = match args.forgejo {
        Some(config) => {
            let token = TokenSource::File(config.token_file.clone());
            Some((Client::forgejo(token, &config.api_root())?, config))
        }
        None => None,
    };
    let kubernetes = match args.kubernetes {
        Some(config) => {
            let root = kubernetes::in_cluster_root(
                std::env::var(kubernetes::HOST_ENV).ok(),
                std::env::var(kubernetes::PORT_ENV).ok(),
            )?;
            let ca = std::fs::read(kubernetes::CA_FILE)
                .with_context(|| format!("reading {}", kubernetes::CA_FILE))?;
            let token = TokenSource::File(kubernetes::TOKEN_FILE.into());
            Some((Client::kubernetes(token, &root, &ca)?, config))
        }
        None => None,
    };
    if !args.static_dir.is_dir() {
        println!(
            "control-app: {} is not a directory; build the app (npm run build) to serve it",
            args.static_dir.display()
        );
    }
    let mut initial = State::empty();
    if board.is_some() {
        initial.decision = Some(Default::default());
    }
    if forgejo.is_some() {
        initial.forgejo = Some(Default::default());
    }
    if kubernetes.is_some() {
        initial.kubernetes = Some(Default::default());
    }
    let (tx, rx) = watch::channel(Arc::new(initial));
    let refresher = tokio::spawn(refresher(
        client,
        board,
        forgejo,
        kubernetes,
        tx,
        args.interval,
    ));
    let listener = tokio::net::TcpListener::bind(args.listen)
        .await
        .with_context(|| format!("listening on {}", args.listen))?;
    let shutdown = terminated();
    println!("control-app: serving http://{}", args.listen);
    axum::serve(
        listener,
        server::router_with_acp(rx, Some(args.static_dir), args.allowed_hosts, acp),
    )
    .with_graceful_shutdown(async move {
        if let Err(e) = shutdown.await {
            println!("control-app: {e:#}");
            std::future::pending::<()>().await;
        }
        println!("control-app: shutting down");
        // Dropping the state's sender ends the event streams, which would
        // otherwise hold the graceful shutdown open.
        refresher.abort();
        // Await the abort so the preview's cancellation guard has run before
        // graceful HTTP/SSE shutdown proceeds.
        let _ = refresher.await;
    })
    .await
    .context("serving")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn slow_ticks_are_serialized_without_catchup_and_shutdown_drops_work() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let starts = Arc::new(AtomicUsize::new(0));
        let active = Arc::new(AtomicUsize::new(0));
        struct Active(Arc<AtomicUsize>);
        impl Drop for Active {
            fn drop(&mut self) {
                self.0.fetch_sub(1, Ordering::SeqCst);
            }
        }
        let task = tokio::spawn({
            let starts = starts.clone();
            let active = active.clone();
            async move {
                periodic(Duration::from_secs(30), || async {
                    assert_eq!(active.fetch_add(1, Ordering::SeqCst), 0);
                    let _active = Active(active.clone());
                    starts.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_secs(100)).await;
                })
                .await;
            }
        });
        tokio::task::yield_now().await;
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        tokio::time::advance(Duration::from_secs(100)).await;
        tokio::task::yield_now().await;
        assert_eq!(active.load(Ordering::SeqCst), 0);
        tokio::time::advance(Duration::from_secs(29)).await;
        tokio::task::yield_now().await;
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
        assert_eq!(starts.load(Ordering::SeqCst), 2);
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(active.load(Ordering::SeqCst), 0);
        tokio::time::advance(Duration::from_secs(1000)).await;
        assert_eq!(starts.load(Ordering::SeqCst), 2);
    }

    fn parse_env(args: &[&str], env: Option<&str>) -> Result<Option<Args>> {
        parse_args(args.iter().map(|s| s.to_string()), env.map(str::to_owned))
    }

    fn parse(args: &[&str]) -> Result<Option<Args>> {
        parse_env(args, None)
    }

    #[test]
    fn args() {
        let a = parse(&[]).unwrap().unwrap();
        assert_eq!(a.listen.to_string(), DEFAULT_LISTEN);
        assert_eq!(a.interval, Duration::from_secs(DEFAULT_INTERVAL_SECS));
        assert_eq!(a.token, TokenConfig::Gh);
        assert!(a.allowed_hosts.is_empty());
        assert!(a.board_config.is_none(), "board reads are off by default");
        assert!(!a.board_once);
        assert!(a.acp_config.is_none(), "ACP attachments are off by default");
        assert_eq!(
            parse(&["--acp-config=sessions.json"])
                .unwrap()
                .unwrap()
                .acp_config,
            Some(PathBuf::from("sessions.json"))
        );
        assert_eq!(
            parse(&["--board-config=board.json"])
                .unwrap()
                .unwrap()
                .board_config,
            Some(PathBuf::from("board.json"))
        );
        let a = parse(&[
            "--listen=127.0.0.1:9000",
            "--static",
            "x",
            "--interval",
            "30",
            "--allow-host",
            "a.example",
            "--allow-host=b.example",
        ])
        .unwrap()
        .unwrap();
        assert_eq!(
            (a.listen.port(), a.static_dir, a.interval.as_secs()),
            (9000, PathBuf::from("x"), 30)
        );
        assert_eq!(a.allowed_hosts, ["a.example", "b.example"]);
        assert!(parse(&["--help"]).unwrap().is_none());
        for (bad, why) in [
            (
                &["--interval", "5"][..],
                "--interval must be 30 to 3600 seconds",
            ),
            (&["--interval"], "--interval needs a value"),
            (
                &["--listen", "localhost"],
                "--listen \"localhost\" is not an address and port",
            ),
            (&["--write", "1"], "unknown option \"--write\""),
            (
                &["--octo-sts-scope", "o"],
                "Octo STS needs all of --octo-sts-scope, --octo-sts-identity and --octo-sts-token-file",
            ),
            (
                &[
                    "--github-token-file=t",
                    "--octo-sts-scope=o",
                    "--octo-sts-identity=i",
                    "--octo-sts-token-file=f",
                ],
                "give either a token file or Octo STS, not both",
            ),
        ] {
            assert_eq!(
                parse(bad).err().map(|e| e.to_string()).as_deref(),
                Some(why)
            );
        }
    }

    #[test]
    fn board_once_accepts_only_its_config_and_token_options() {
        let a = parse(&["--board-once=board.json", "--github-token-file", "token"])
            .unwrap()
            .unwrap();
        assert!(a.board_once);
        assert_eq!(a.board_config, Some("board.json".into()));
        assert_eq!(a.token, TokenConfig::File("token".into()));
        for flag in [
            "--listen",
            "--static",
            "--interval",
            "--board-config",
            "--acp-config",
            "--forgejo-url",
            "--kubernetes-namespace",
            "--allow-host",
        ] {
            let value = if flag == "--interval" { "60" } else { "unused" };
            for args in [
                vec!["--board-once", "board.json", flag, value],
                vec![flag, value, "--board-once", "board.json"],
            ] {
                assert_eq!(
                    parse(&args).err().unwrap().to_string(),
                    "--board-once accepts only GitHub token options"
                );
            }
        }
        assert!(parse(&["--board-once"]).is_err());
    }

    #[test]
    fn preview_output_requires_complete_error_free_evidence_and_successful_write() {
        let mut state = State::empty();
        state.decision = Some(state::Section {
            complete: true,
            ..Default::default()
        });
        let mut bytes = Vec::new();
        write_preview(&state, &mut bytes).unwrap();
        assert_eq!(bytes.last(), Some(&b'\n'));
        assert!(serde_json::from_slice::<serde_json::Value>(&bytes).is_ok());
        assert!(write_preview(&state, &mut [0u8; 1][..]).is_err());
        state.decision.as_mut().unwrap().error = Some("unavailable".into());
        assert!(write_preview(&state, Vec::new()).is_err());
        state.decision = None;
        assert!(write_preview(&state, Vec::new()).is_err());
    }

    #[test]
    fn forgejo_args() {
        assert!(
            parse(&[]).unwrap().unwrap().forgejo.is_none(),
            "Forgejo reads are off by default"
        );
        let a = parse(&[
            "--forgejo-url=https://forge.example",
            "--forgejo-token-file=/run/forgejo-token",
            "--forgejo-org=o1",
            "--forgejo-org=o2",
            "--forgejo-label=l",
            "--forgejo-reviewer=u",
        ])
        .unwrap()
        .unwrap();
        assert_eq!(
            a.forgejo,
            Some(forgejo::Config {
                url: "https://forge.example".into(),
                token_file: "/run/forgejo-token".into(),
                orgs: vec!["o1".into(), "o2".into()],
                labels: vec!["l".into()],
                reviewer: Some("u".into()),
            })
        );
        assert_eq!(
            parse(&["--forgejo-reviewer=u"])
                .err()
                .map(|e| e.to_string())
                .as_deref(),
            Some("the --forgejo-* options need --forgejo-url")
        );
    }

    #[tokio::test]
    async fn forgejo_section_only_when_configured() {
        use crate::state::tests::Recorded;
        let github = Recorded::fixture();
        let forge = Recorded::from_fixture(include_str!("../fixtures/forgejo.json"));
        let config = forgejo::Config::new(
            "https://forge.example",
            Some("t".into()),
            vec![],
            vec![],
            Some("operator".into()),
        )
        .unwrap();
        let clock = || "2026-11-10T12:00:00Z".to_owned();
        let empty = State::empty();
        let off = refresh_generation(&github, None, NO_FORGEJO, NO_KUBERNETES, &empty, clock);
        let off = serde_json::to_value(off.await).unwrap();
        assert!(off.get("forgejo").is_none());
        let forgejo = Some((&forge, &config));
        let on = refresh_generation(&github, None, forgejo, NO_KUBERNETES, &empty, clock);
        let on = on.await.forgejo.unwrap();
        assert_eq!((on.items.len(), on.complete), (2, true));
    }

    const NO_FORGEJO: Option<(&state::tests::Recorded, &forgejo::Config)> = None;

    const NO_KUBERNETES: Option<(&state::tests::Recorded, &kubernetes::Config)> = None;

    #[test]
    fn kubernetes_args() {
        let a = parse(&[]).unwrap().unwrap();
        assert!(
            a.kubernetes.is_none(),
            "Kubernetes reads are off by default"
        );
        let a = parse(&["--kubernetes-namespace=a", "--kubernetes-namespace", "b"]);
        assert_eq!(
            a.unwrap().unwrap().kubernetes,
            Some(kubernetes::Config {
                namespaces: vec!["a".into(), "b".into()]
            })
        );
    }

    #[tokio::test]
    async fn kubernetes_section_only_when_configured() {
        use crate::state::tests::Recorded;
        let github = Recorded::fixture();
        let cluster = Recorded::from_fixture(include_str!("../fixtures/kubernetes.json"));
        let config = kubernetes::Config::new(vec!["apps".into()]).unwrap();
        let clock = || "2026-11-10T12:00:00Z".to_owned();
        let empty = State::empty();
        let off = refresh_generation(&github, None, NO_FORGEJO, NO_KUBERNETES, &empty, clock);
        let off = serde_json::to_value(off.await).unwrap();
        assert!(off.get("kubernetes").is_none());
        let kubernetes = Some((&cluster, &config));
        let on = refresh_generation(&github, None, NO_FORGEJO, kubernetes, &empty, clock);
        let on = on.await.kubernetes.unwrap();
        assert_eq!((on.items.len(), on.complete), (5, true));
    }

    #[test]
    fn token_args() {
        let token = |args: &[&str], env| parse_env(args, env).unwrap().unwrap().token;
        let file = |f: &str| TokenConfig::File(f.into());
        assert_eq!(token(&[], Some("/run/t")), file("/run/t"));
        assert_eq!(token(&[], Some("")), TokenConfig::Gh);
        assert_eq!(
            token(&["--github-token-file", "/a"], Some("/run/t")),
            file("/a"),
            "the flag wins"
        );
        assert_eq!(
            token(
                &[
                    "--octo-sts-scope=jmarrero-forge",
                    "--octo-sts-identity=control-plane",
                    "--octo-sts-token-file=/var/run/secrets/tokens/octo-sts",
                ],
                None
            ),
            TokenConfig::OctoSts {
                scope: "jmarrero-forge".into(),
                identity: "control-plane".into(),
                token_file: "/var/run/secrets/tokens/octo-sts".into(),
            }
        );
    }
}
