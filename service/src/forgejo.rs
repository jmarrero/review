//! The Forgejo source: open issues carrying configured labels in configured
//! organizations, and open PRs requesting the configured reviewer's review,
//! read with GETs from one Forgejo instance's API. It is off unless
//! `--forgejo-url` is given; the code names no instance, organization or
//! label (service/README.md).

use std::path::PathBuf;

use anyhow::{Context, Result, bail, ensure};
use futures_util::future::join_all;
use serde::Serialize;
use serde_json::Value;

use crate::github::Source;
use crate::state::{Read, Section, str_of, summarize, u64_of};

/// The most organizations one refresh searches, a search each.
pub const MAX_ORGS: usize = 10;

/// The most labels; one search asks for all of them.
pub const MAX_LABELS: usize = 20;

/// Items per search. Only the first page is read, at most this or the
/// instance's `max_response_items`; a full page marks the section incomplete.
const PAGE_SIZE: u64 = 50;

/// An item's reason: an issue carrying a configured label.
const LABELED: &str = "labeled";

/// An item's reason: a PR requesting the reviewer's review.
const REVIEW_REQUESTED: &str = "review-requested";

/// The instance and what to read from it, as configured.
#[derive(Debug, PartialEq)]
pub struct Config {
    /// The instance's base URL, without /api/v1 or a trailing slash.
    pub url: String,
    /// A file holding a read-only token, reread for every request.
    pub token_file: PathBuf,
    pub orgs: Vec<String>,
    pub labels: Vec<String>,
    /// The token's user, whose requested reviews are read.
    pub reviewer: Option<String>,
}

impl Config {
    pub fn new(
        url: &str,
        token_file: Option<PathBuf>,
        orgs: Vec<String>,
        labels: Vec<String>,
        reviewer: Option<String>,
    ) -> Result<Self> {
        let parsed = reqwest::Url::parse(url)
            .ok()
            .filter(|u| matches!(u.scheme(), "http" | "https") && u.has_host())
            .with_context(|| format!("--forgejo-url {url:?} is not an http(s) URL"))?;
        ensure!(
            parsed.query().is_none() && parsed.fragment().is_none(),
            "--forgejo-url {url:?} has a query or fragment"
        );
        let token_file = token_file.context("--forgejo-url needs --forgejo-token-file")?;
        ensure!(
            orgs.is_empty() == labels.is_empty(),
            "--forgejo-org and --forgejo-label go together"
        );
        ensure!(
            !orgs.is_empty() || reviewer.is_some(),
            "--forgejo-url needs --forgejo-org with --forgejo-label, or --forgejo-reviewer"
        );
        ensure!(
            orgs.len() <= MAX_ORGS && labels.len() <= MAX_LABELS,
            "at most {MAX_ORGS} --forgejo-org and {MAX_LABELS} --forgejo-label"
        );
        let values = orgs.iter().map(|v| ("--forgejo-org", v));
        let values = values.chain(labels.iter().map(|v| ("--forgejo-label", v)));
        for (flag, v) in values.chain(reviewer.iter().map(|v| ("--forgejo-reviewer", v))) {
            if v.is_empty() || v.trim() != v || v.contains(',') {
                bail!("{flag} {v:?} is empty, padded or has a comma");
            }
        }
        // Forgejo matches owners case-insensitively; a repeated organization
        // would list its issues twice.
        for (i, org) in orgs.iter().enumerate() {
            if orgs[..i].iter().any(|o| o.eq_ignore_ascii_case(org)) {
                bail!("--forgejo-org {org:?} is given twice");
            }
        }
        Ok(Self {
            url: url.trim_end_matches('/').to_owned(),
            token_file,
            orgs,
            labels,
            reviewer,
        })
    }

    /// The root of the instance's API.
    pub fn api_root(&self) -> String {
        format!("{}/api/v1", self.url)
    }
}

/// An issue or PR on the instance that waits on the operator.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    /// OWNER/REPO on the instance.
    pub repository: String,
    pub number: u64,
    pub url: String,
    pub title: String,
    pub pull_request: bool,
    pub draft: bool,
    pub labels: Vec<String>,
    /// Why it waits: LABELED (an issue) or REVIEW_REQUESTED (a PR).
    pub reason: &'static str,
    pub updated_at: String,
}

/// Read the section afresh; a failed read keeps `prev`'s items.
pub async fn refresh<S: Source>(
    src: &S,
    config: &Config,
    prev: Option<&Section<Item>>,
    now: &str,
) -> Section<Item> {
    let none = Section::default();
    crate::state::section(load(src, config).await, prev.unwrap_or(&none), now)
}

/// The issue search's path for `filters`, open items, most recently updated first.
fn search_path(filters: &[(&str, &str)], limit: u64) -> String {
    let limit = limit.to_string();
    let mut query = vec![("state", "open")];
    query.extend_from_slice(filters);
    query.extend([("sort", "recentupdate"), ("limit", limit.as_str())]);
    // Only the path and its encoded query are kept; the base is a placeholder.
    let url = reqwest::Url::parse_with_params("http://forgejo/repos/issues/search", query)
        .expect("a search URL from a constant base");
    format!("{}?{}", url.path(), url.query().unwrap_or_default())
}

fn parse_item(v: &Value, reason: &'static str) -> Result<Item> {
    let repository = v
        .get("repository")
        .context("answer has no repository")
        .and_then(|r| str_of(r, "full_name"))?;
    let pull = v.get("pull_request").filter(|p| p.is_object());
    Ok(Item {
        repository: repository.to_owned(),
        number: u64_of(v, "number")?,
        url: str_of(v, "html_url")?.to_owned(),
        title: str_of(v, "title")?.to_owned(),
        pull_request: pull.is_some(),
        draft: pull
            .and_then(|p| p.get("draft"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        labels: v
            .get("labels")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|l| l.get("name").and_then(Value::as_str).map(str::to_owned))
            .collect(),
        reason,
        updated_at: str_of(v, "updated_at")?.to_owned(),
    })
}

/// Fails unless the token is `reviewer`'s: Forgejo lists only the token
/// user's requested reviews.
async fn check_reviewer<S: Source>(src: &S, reviewer: &str) -> Result<()> {
    let user = src.get("/user").await?;
    let login = str_of(&user, "login").context("GET /user")?;
    ensure!(
        login.eq_ignore_ascii_case(reviewer),
        "the Forgejo token is {login}'s, not --forgejo-reviewer {reviewer}'s; \
         Forgejo lists only the token user's requested reviews"
    );
    Ok(())
}

/// One search per organization for the labels, and one for the reviewer's
/// requested reviews, all at once. A failed search is a failure and leaves
/// the others' items; the section fails wholly only when none succeeds.
async fn load<S: Source>(src: &S, config: &Config) -> Result<Read<Item>> {
    let settings = src.get("/settings/api").await?;
    let limit = u64_of(&settings, "max_response_items")
        .context("GET /settings/api")?
        .clamp(1, PAGE_SIZE);
    let labels = config.labels.join(",");
    let mut searches: Vec<(&'static str, String)> = config
        .orgs
        .iter()
        .map(|org| {
            let filters = [("type", "issues"), ("owner", org), ("labels", &labels)];
            (LABELED, search_path(&filters, limit))
        })
        .collect();
    let mut failures = Vec::new();
    if let Some(reviewer) = &config.reviewer {
        match check_reviewer(src, reviewer).await {
            Ok(()) => {
                let filters = [("type", "pulls"), ("review_requested", "true")];
                searches.push((REVIEW_REQUESTED, search_path(&filters, limit)));
            }
            Err(e) => failures.push(format!("{e:#}")),
        }
    }
    let answers = join_all(searches.iter().map(|(_, path)| src.get(path))).await;
    // The label searches find only issues and the review search only PRs,
    // and organizations are distinct, so no item is found twice.
    let mut complete = true;
    let mut read = 0;
    let mut found: Vec<Item> = Vec::new();
    for ((reason, path), answer) in searches.iter().zip(answers) {
        let parsed = answer.and_then(|a| {
            let items = a
                .as_array()
                .with_context(|| format!("GET {path}: answer is not a list"))?;
            let parsed = items.iter().map(|v| parse_item(v, reason));
            let parsed = parsed.collect::<Result<Vec<_>>>();
            Ok((parsed.with_context(|| format!("GET {path}"))?, items.len()))
        });
        match parsed {
            Ok((items, n)) => {
                read += 1;
                complete &= (n as u64) < limit;
                // Forgejo discards label names it doesn't know, and with
                // none left it doesn't filter by label at all: a misspelled
                // or renamed label would list every open issue. Drop those,
                // and say so rather than show an unexplained empty section.
                let (kept, dropped): (Vec<_>, Vec<_>) = items.into_iter().partition(|i| {
                    *reason != LABELED || i.labels.iter().any(|l| config.labels.contains(l))
                });
                if !dropped.is_empty() {
                    failures.push(format!(
                        "GET {path}: {} issues carry no --forgejo-label; \
                         is each one a label on the instance, by exact name?",
                        dropped.len()
                    ));
                }
                found.extend(kept);
            }
            Err(e) => failures.push(format!("{e:#}")),
        }
    }
    if read == 0 {
        bail!(summarize(&failures).unwrap_or_default());
    }
    found.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(Read {
        items: found,
        complete,
        failures,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::state::tests::Recorded;

    const NOW: &str = "2026-11-10T12:00:00Z";

    fn recorded() -> Recorded {
        Recorded::from_fixture(include_str!("../fixtures/forgejo.json"))
    }

    /// The fixture's configuration: two organizations, two labels, a reviewer.
    fn config() -> Config {
        Config::new(
            "https://forge.example/",
            Some("/run/forgejo-token".into()),
            vec!["infra".into(), "homelab".into()],
            vec!["needs operator".into(), "blocked".into()],
            Some("operator".into()),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn builds_section_from_searches() {
        let section = refresh(&recorded(), &config(), None, NOW).await;
        let v = serde_json::to_value(&section).unwrap();
        let expected: Value =
            serde_json::from_str(include_str!("../fixtures/forgejo-state.json")).unwrap();
        assert_eq!(
            v,
            expected,
            "got {}",
            serde_json::to_string_pretty(&v).unwrap()
        );
    }

    #[tokio::test]
    async fn a_full_page_is_incomplete() {
        let mut src = recorded();
        // An instance answering at most two items a search: the searches
        // ask for two, and a search that fills its page may have more.
        let at_two: Vec<(String, Value)> = src
            .0
            .iter()
            .filter_map(|(k, v)| {
                Some((
                    k.strip_suffix("limit=50")?.to_owned() + "limit=2",
                    v.clone(),
                ))
            })
            .collect();
        src.0.extend(at_two);
        src.0
            .insert("/settings/api".into(), json!({"max_response_items": 2}));
        let section = refresh(&src, &config(), None, NOW).await;
        assert!(!section.complete, "the review search found two");
        assert_eq!(section.read_at.as_deref(), Some(NOW));
        assert!(section.error.is_none());
    }

    #[tokio::test]
    async fn another_users_token_is_refused() {
        let mut src = recorded();
        src.0
            .insert("/user".into(), json!({"login": "someone-else"}));
        let section = refresh(&src, &config(), None, NOW).await;
        assert_eq!(
            section.error.as_deref(),
            Some(
                "the Forgejo token is someone-else's, not --forgejo-reviewer operator's; \
                 Forgejo lists only the token user's requested reviews"
            )
        );
        assert!(!section.complete);
        assert_eq!(section.read_at.as_deref(), Some(NOW));
        let labeled_only = |s: &Section<Item>| {
            !s.items.is_empty()
                && s.items
                    .iter()
                    .all(|i| i.reason == LABELED && !i.pull_request)
        };
        assert!(labeled_only(&section), "the label searches still count");

        // Without a reviewer, the token's user is not asked for.
        let mut labels_only = config();
        labels_only.reviewer = None;
        let section = refresh(&src, &labels_only, None, NOW).await;
        assert!(section.error.is_none(), "{:?}", section.error);
        assert!(section.complete && labeled_only(&section));
    }

    #[tokio::test]
    async fn unlabeled_issues_are_dropped_and_reported() {
        // What Forgejo answers when it knows none of the labels: open
        // issues regardless of label.
        let mut src = recorded();
        let path = "/repos/issues/search?state=open&type=issues&owner=homelab\
                    &labels=needs+operator%2Cblocked&sort=recentupdate&limit=50";
        src.0.insert(
            path.into(),
            json!([{
                "number": 3, "title": "Not labeled", "pull_request": null,
                "html_url": "https://forge.example/homelab/media/issues/3",
                "labels": [{"name": "enhancement"}, {"name": "Blocked"}],
                "repository": {"full_name": "homelab/media"},
                "updated_at": "2026-11-10T11:00:00Z"
            }]),
        );
        let section = refresh(&src, &config(), None, NOW).await;
        assert!(section.items.iter().all(|i| i.number != 3));
        assert_eq!(section.items.len(), 4, "the other searches' items stay");
        assert!(!section.complete);
        assert_eq!(
            section.error.unwrap(),
            format!(
                "GET {path}: 1 issues carry no --forgejo-label; \
                 is each one a label on the instance, by exact name?"
            )
        );
    }

    #[tokio::test]
    async fn a_failed_search_leaves_the_others() {
        let mut src = recorded();
        src.0.retain(|k, _| !k.contains("owner=homelab"));
        let section = refresh(&src, &config(), None, NOW).await;
        assert_eq!(section.items.len(), 4, "infra's and the review search's");
        assert!(!section.complete);
        assert_eq!(section.read_at.as_deref(), Some(NOW));
        let error = section.error.unwrap();
        assert!(
            error.starts_with("GET /repos/issues/search?state=open&type=issues&owner=homelab")
                && error.ends_with("HTTP 404: Not Found"),
            "{error}"
        );

        // With every search failing, the section keeps its last items.
        let first = refresh(&recorded(), &config(), None, NOW).await;
        src.0.retain(|k, _| !k.starts_with("/repos/issues/search"));
        let later = "2026-11-10T12:01:00Z";
        let section = refresh(&src, &config(), Some(&first), later).await;
        assert_eq!(section.read_at.as_deref(), Some(NOW));
        assert_eq!(section.items.len(), first.items.len());
        assert!(section.error.unwrap().ends_with("Not Found (and 2 more)"));
    }

    #[test]
    fn search_paths_are_encoded() {
        assert_eq!(
            search_path(&[("labels", "needs operator,blocked")], 50),
            "/repos/issues/search?state=open&labels=needs+operator%2Cblocked&sort=recentupdate&limit=50"
        );
    }

    #[test]
    fn config_is_checked() {
        let c = config();
        assert_eq!(c.url, "https://forge.example");
        assert_eq!(c.api_root(), "https://forge.example/api/v1");
        let owned = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let many: Vec<&str> = std::iter::repeat_n("o", MAX_ORGS + 1).collect();
        for (url, token, orgs, labels, reviewer, why) in [
            (
                "forge.example",
                true,
                &["o"][..],
                &["l"][..],
                None,
                "--forgejo-url \"forge.example\" is not an http(s) URL",
            ),
            (
                "ftp://forge.example",
                true,
                &["o"],
                &["l"],
                None,
                "--forgejo-url \"ftp://forge.example\" is not an http(s) URL",
            ),
            (
                "https://forge.example/?x=1",
                true,
                &["o"],
                &["l"],
                None,
                "--forgejo-url \"https://forge.example/?x=1\" has a query or fragment",
            ),
            (
                "https://forge.example",
                false,
                &["o"],
                &["l"],
                None,
                "--forgejo-url needs --forgejo-token-file",
            ),
            (
                "https://forge.example",
                true,
                &["o"],
                &[],
                Some("u"),
                "--forgejo-org and --forgejo-label go together",
            ),
            (
                "https://forge.example",
                true,
                &[],
                &[],
                None,
                "--forgejo-url needs --forgejo-org with --forgejo-label, or --forgejo-reviewer",
            ),
            (
                "https://forge.example",
                true,
                &many,
                &["l"],
                None,
                "at most 10 --forgejo-org and 20 --forgejo-label",
            ),
            (
                "https://forge.example",
                true,
                &["o"],
                &["a,b"],
                None,
                "--forgejo-label \"a,b\" is empty, padded or has a comma",
            ),
            (
                "https://forge.example",
                true,
                &["o "],
                &["l"],
                None,
                "--forgejo-org \"o \" is empty, padded or has a comma",
            ),
            (
                "https://forge.example",
                true,
                &[],
                &[],
                Some(""),
                "--forgejo-reviewer \"\" is empty, padded or has a comma",
            ),
            (
                "https://forge.example",
                true,
                &["infra", "Infra"],
                &["l"],
                None,
                "--forgejo-org \"Infra\" is given twice",
            ),
        ] {
            let err = Config::new(
                url,
                token.then(|| "t".into()),
                owned(orgs),
                owned(labels),
                reviewer.map(str::to_owned),
            )
            .unwrap_err();
            assert_eq!(err.to_string(), why);
        }
        // A reviewer alone is enough.
        Config::new(
            "http://127.0.0.1:3000",
            Some("t".into()),
            vec![],
            vec![],
            Some("u".into()),
        )
        .unwrap();
    }
}
