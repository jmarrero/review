//! The Kubernetes source: Flux Kustomizations, Deployments, and pods that
//! are crash-looping, restarting or pending, listed with GETs in the
//! configured namespaces of the cluster the service runs in. It is off
//! unless `--kubernetes-namespace` is given; the code names no namespace
//! (service/README.md).

use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use futures_util::future::join_all;
use serde::Serialize;
use serde_json::Value;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::github::Source;
use crate::state::{Read, Section, str_of, summarize};

/// The most namespaces one refresh lists, three lists each.
pub const MAX_NAMESPACES: usize = 10;

/// Where in-cluster config finds the API server.
pub const HOST_ENV: &str = "KUBERNETES_SERVICE_HOST";

pub const PORT_ENV: &str = "KUBERNETES_SERVICE_PORT";

/// The pod's service-account token, which the kubelet rotates; reread for
/// every request.
pub const TOKEN_FILE: &str = "/var/run/secrets/kubernetes.io/serviceaccount/token";

/// The cluster's CA, the only root trusted for the API server.
pub const CA_FILE: &str = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";

/// Objects per list. Only the first page is read; a list with more marks
/// the section incomplete.
const PAGE_SIZE: u64 = 200;

/// Flux's Kustomization API.
const KUSTOMIZATIONS: &str = "/apis/kustomize.toolkit.fluxcd.io/v1";

/// Pods in these phases have finished, so they are not listed.
const FINISHED_PODS: &str = "status.phase!=Succeeded,status.phase!=Failed";

/// A pod whose container last terminated this recently is restarting.
const RECENT_RESTART: Duration = Duration::from_secs(60 * 60);

/// A pod pending this long is listed; a shorter wait is a pod starting.
const PENDING_AFTER: Duration = Duration::from_secs(5 * 60);

/// The waiting reason of a container the kubelet backs off restarting.
const CRASH_LOOP_BACK_OFF: &str = "CrashLoopBackOff";

/// What to read, as configured.
#[derive(Debug, PartialEq)]
pub struct Config {
    pub namespaces: Vec<String>,
}

impl Config {
    pub fn new(namespaces: Vec<String>) -> Result<Self> {
        ensure!(
            namespaces.len() <= MAX_NAMESPACES,
            "at most {MAX_NAMESPACES} --kubernetes-namespace"
        );
        for (i, ns) in namespaces.iter().enumerate() {
            // A DNS label, as Kubernetes requires, so it is safe in a path.
            let label = !ns.is_empty()
                && ns.len() <= 63
                && ns
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                && !ns.starts_with('-')
                && !ns.ends_with('-');
            ensure!(
                label,
                "--kubernetes-namespace {ns:?} is not a namespace name"
            );
            ensure!(
                !namespaces[..i].contains(ns),
                "--kubernetes-namespace {ns:?} is given twice"
            );
        }
        Ok(Self { namespaces })
    }
}

/// The API server's URL from in-cluster config's environment.
pub fn in_cluster_root(host: Option<String>, port: Option<String>) -> Result<String> {
    let host = host.filter(|h| !h.is_empty()).with_context(|| {
        format!("--kubernetes-namespace needs in-cluster config; ${HOST_ENV} is unset")
    })?;
    let port = port
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| "443".into());
    let host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host
    };
    Ok(format!("https://{host}:{port}"))
}

/// One object the section reports, by its Kubernetes kind.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind")]
pub enum Item {
    Kustomization(Kustomization),
    Deployment(Deployment),
    Pod(Pod),
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Kustomization {
    pub namespace: String,
    pub name: String,
    /// The Ready condition: null when Unknown or absent.
    pub ready: Option<bool>,
    /// The Ready condition's message.
    pub message: Option<String>,
    pub applied_revision: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Deployment {
    pub namespace: String,
    pub name: String,
    /// One per container of the pod template, init containers excluded.
    pub images: Vec<Image>,
    /// The desired replicas.
    pub replicas: u64,
    pub ready_replicas: u64,
    pub updated_replicas: u64,
    /// Whether a rollout hasn't finished, as `kubectl rollout status` decides.
    pub rolling_out: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Image {
    pub container: String,
    pub image: String,
    /// The reference's tag; null when it has none (latest, or a digest only).
    pub tag: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pod {
    pub namespace: String,
    pub name: String,
    pub phase: String,
    /// CRASH_LOOPING, PENDING or RESTARTING, the first that applies.
    pub problem: &'static str,
    /// The containers' restarts, init containers included.
    pub restarts: u64,
    /// Why: a container's waiting or last termination reason, or the pod's
    /// scheduling reason.
    pub reason: Option<String>,
}

/// A pod problem: a container the kubelet backs off restarting.
const CRASH_LOOPING: &str = "crash-looping";

/// A pod problem: pending for at least PENDING_AFTER.
const PENDING: &str = "pending";

/// A pod problem: a container terminated within RECENT_RESTART and restarted.
const RESTARTING: &str = "restarting";

/// Read the section afresh; a failed read keeps `prev`'s items.
pub async fn refresh<S: Source>(
    src: &S,
    config: &Config,
    prev: Option<&Section<Item>>,
    now: &str,
) -> Section<Item> {
    let none = Section::default();
    crate::state::section(load(src, config, now).await, prev.unwrap_or(&none), now)
}

/// What one list's objects become.
#[derive(Clone, Copy)]
enum List {
    Kustomizations,
    Deployments,
    Pods,
}

impl List {
    fn path(self, ns: &str) -> String {
        match self {
            Self::Kustomizations => {
                format!("{KUSTOMIZATIONS}/namespaces/{ns}/kustomizations?limit={PAGE_SIZE}")
            }
            Self::Deployments => {
                format!("/apis/apps/v1/namespaces/{ns}/deployments?limit={PAGE_SIZE}")
            }
            Self::Pods => {
                let url = reqwest::Url::parse_with_params(
                    "http://kubernetes/",
                    [
                        ("fieldSelector", FINISHED_PODS),
                        ("limit", &PAGE_SIZE.to_string()),
                    ],
                )
                .expect("a list URL from a constant base");
                format!(
                    "/api/v1/namespaces/{ns}/pods?{}",
                    url.query().unwrap_or_default()
                )
            }
        }
    }

    fn parse(self, v: &Value, now: OffsetDateTime) -> Result<Option<Item>> {
        Ok(match self {
            Self::Kustomizations => Some(Item::Kustomization(kustomization(v)?)),
            Self::Deployments => Some(Item::Deployment(deployment(v)?)),
            Self::Pods => pod(v, now)?.map(Item::Pod),
        })
    }
}

fn namespace_and_name(v: &Value) -> Result<(String, String)> {
    let meta = v.get("metadata").context("object has no metadata")?;
    Ok((
        str_of(meta, "namespace")?.to_owned(),
        str_of(meta, "name")?.to_owned(),
    ))
}

/// A number at `path` under `v`, 0 when absent, as Kubernetes omits zeros.
fn count(v: &Value, path: &str) -> u64 {
    v.pointer(path).and_then(Value::as_u64).unwrap_or(0)
}

fn string(v: &Value, path: &str) -> Option<String> {
    v.pointer(path).and_then(Value::as_str).map(str::to_owned)
}

fn array<'a>(v: &'a Value, path: &str) -> impl Iterator<Item = &'a Value> {
    v.pointer(path)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

fn kustomization(v: &Value) -> Result<Kustomization> {
    let (namespace, name) = namespace_and_name(v)?;
    let ready = array(v, "/status/conditions").find(|c| c["type"] == "Ready");
    Ok(Kustomization {
        namespace,
        name,
        ready: ready.and_then(|c| match c["status"].as_str() {
            Some("True") => Some(true),
            Some("False") => Some(false),
            _ => None,
        }),
        message: ready.and_then(|c| string(c, "/message")),
        applied_revision: string(v, "/status/lastAppliedRevision"),
    })
}

/// The tag of an image reference: after the last `:` of its last path
/// component, before any `@digest`.
fn image_tag(image: &str) -> Option<&str> {
    let name = image.split('@').next().unwrap_or(image);
    let last = name.rsplit('/').next().unwrap_or(name);
    last.split_once(':').map(|(_, tag)| tag)
}

fn deployment(v: &Value) -> Result<Deployment> {
    let (namespace, name) = namespace_and_name(v)?;
    let images = array(v, "/spec/template/spec/containers")
        .map(|c| {
            let image = str_of(c, "image").unwrap_or_default();
            Image {
                container: str_of(c, "name").unwrap_or_default().to_owned(),
                image: image.to_owned(),
                tag: image_tag(image).map(str::to_owned),
            }
        })
        .collect();
    let replicas = v
        .pointer("/spec/replicas")
        .and_then(Value::as_u64)
        .unwrap_or(1);
    let updated = count(v, "/status/updatedReplicas");
    let rolling_out = count(v, "/status/observedGeneration") < count(v, "/metadata/generation")
        || updated < replicas
        || count(v, "/status/replicas") > updated
        || count(v, "/status/availableReplicas") < updated;
    Ok(Deployment {
        namespace,
        name,
        images,
        replicas,
        ready_replicas: count(v, "/status/readyReplicas"),
        updated_replicas: updated,
        rolling_out,
    })
}

fn timestamp(s: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(s, &Rfc3339).ok()
}

/// The pod, if it is crash-looping, pending or restarting.
fn pod(v: &Value, now: OffsetDateTime) -> Result<Option<Pod>> {
    let (namespace, name) = namespace_and_name(v)?;
    let phase = string(v, "/status/phase").unwrap_or_default();
    let statuses: Vec<&Value> = array(v, "/status/initContainerStatuses")
        .chain(array(v, "/status/containerStatuses"))
        .collect();
    let waiting = |reason: Option<&str>| {
        statuses.iter().find_map(|s| {
            let r = s.pointer("/state/waiting/reason")?.as_str()?;
            reason.is_none_or(|want| r == want).then(|| r.to_owned())
        })
    };
    let since = |t: Option<&str>| t.and_then(timestamp).map(|t| now - t);
    let recent_restart = statuses
        .iter()
        .filter(|s| count(s, "/restartCount") > 0)
        .filter_map(|s| {
            let finished = s.pointer("/lastState/terminated/finishedAt")?.as_str();
            let ago = since(finished)?;
            (ago <= RECENT_RESTART).then(|| string(s, "/lastState/terminated/reason"))
        })
        .next();
    let pending_for = since(
        v.pointer("/metadata/creationTimestamp")
            .and_then(Value::as_str),
    );
    let (problem, reason) = if let Some(r) = waiting(Some(CRASH_LOOP_BACK_OFF)) {
        (CRASH_LOOPING, Some(r))
    } else if phase == "Pending" && pending_for.is_some_and(|d| d >= PENDING_AFTER) {
        let unscheduled = array(v, "/status/conditions")
            .find(|c| c["type"] == "PodScheduled" && c["status"] == "False")
            .and_then(|c| string(c, "/reason"));
        (PENDING, waiting(None).or(unscheduled))
    } else if let Some(reason) = recent_restart {
        (RESTARTING, reason)
    } else {
        return Ok(None);
    };
    Ok(Some(Pod {
        namespace,
        name,
        phase,
        problem,
        restarts: statuses.iter().map(|s| count(s, "/restartCount")).sum(),
        reason,
    }))
}

/// Three lists per namespace, all at once. A failed list is a failure and
/// leaves the others' items; the section fails wholly only when none succeeds.
async fn load<S: Source>(src: &S, config: &Config, now: &str) -> Result<Read<Item>> {
    let now = timestamp(now).with_context(|| format!("{now:?} is not an RFC 3339 time"))?;
    let lists: Vec<(List, String)> = config
        .namespaces
        .iter()
        .flat_map(|ns| {
            [List::Kustomizations, List::Deployments, List::Pods].map(|l| (l, l.path(ns)))
        })
        .collect();
    let answers = join_all(lists.iter().map(|(_, path)| src.get(path))).await;
    let mut complete = true;
    let mut failures = Vec::new();
    let mut read = 0;
    let mut found = Vec::new();
    for ((list, path), answer) in lists.iter().zip(answers) {
        let parsed = answer.and_then(|a| {
            let objects = a
                .get("items")
                .and_then(Value::as_array)
                .with_context(|| format!("GET {path}: answer has no items"))?;
            let parsed = objects.iter().map(|v| list.parse(v, now));
            let parsed = parsed.collect::<Result<Vec<_>>>();
            let more = a
                .pointer("/metadata/continue")
                .and_then(Value::as_str)
                .is_some_and(|c| !c.is_empty());
            Ok((parsed.with_context(|| format!("GET {path}"))?, more))
        });
        match parsed {
            Ok((items, more)) => {
                read += 1;
                complete &= !more;
                found.extend(items.into_iter().flatten());
            }
            Err(e) => failures.push(format!("{e:#}")),
        }
    }
    if read == 0 {
        bail!(summarize(&failures).unwrap_or_default());
    }
    Ok(Read {
        items: found,
        complete,
        failures,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::tests::Recorded;

    const NOW: &str = "2026-11-10T12:00:00Z";

    fn recorded() -> Recorded {
        Recorded::from_fixture(include_str!("../fixtures/kubernetes.json"))
    }

    fn config() -> Config {
        Config::new(vec!["apps".into(), "flux-system".into()]).unwrap()
    }

    #[tokio::test]
    async fn builds_section_from_lists() {
        let section = refresh(&recorded(), &config(), None, NOW).await;
        let v = serde_json::to_value(&section).unwrap();
        let expected: Value =
            serde_json::from_str(include_str!("../fixtures/kubernetes-state.json")).unwrap();
        assert_eq!(
            v,
            expected,
            "got {}",
            serde_json::to_string_pretty(&v).unwrap()
        );
    }

    #[tokio::test]
    async fn a_continued_list_is_incomplete() {
        let mut src = recorded();
        let path = List::Deployments.path("apps");
        src.0.get_mut(&path).unwrap()["metadata"]["continue"] = "token".into();
        let section = refresh(&src, &config(), None, NOW).await;
        assert!(!section.complete);
        assert!(section.error.is_none());
    }

    #[tokio::test]
    async fn a_failed_list_leaves_the_others() {
        // As in a namespace where Flux's API isn't installed or allowed.
        let mut src = recorded();
        let path = List::Kustomizations.path("flux-system");
        src.0.remove(&path);
        let section = refresh(&src, &config(), None, NOW).await;
        assert!(!section.complete);
        assert_eq!(
            section.error.unwrap(),
            format!("GET {path}: HTTP 404: Not Found")
        );
        assert!(
            section
                .items
                .iter()
                .all(|i| !matches!(i, Item::Kustomization(k) if k.namespace == "flux-system"))
        );
        assert!(!section.items.is_empty());

        // With every list failing, the section keeps its last items.
        let first = refresh(&recorded(), &config(), None, NOW).await;
        let later = "2026-11-10T12:01:00Z";
        let section = refresh(
            &Recorded(Default::default()),
            &config(),
            Some(&first),
            later,
        )
        .await;
        assert_eq!(section.read_at.as_deref(), Some(NOW));
        assert_eq!(section.items.len(), first.items.len());
        assert!(section.error.unwrap().ends_with("Not Found (and 5 more)"));
    }

    #[test]
    fn pod_lists_skip_finished_pods() {
        assert_eq!(
            List::Pods.path("apps"),
            "/api/v1/namespaces/apps/pods?fieldSelector=status.phase%21%3DSucceeded%2Cstatus.phase%21%3DFailed&limit=200"
        );
    }

    #[test]
    fn image_tags() {
        for (image, tag) in [
            ("registry.example:5000/app:v1.2", Some("v1.2")),
            ("registry.example:5000/app", None),
            ("app", None),
            ("app:1@sha256:abc", Some("1")),
            ("app@sha256:abc", None),
        ] {
            assert_eq!(image_tag(image), tag, "{image}");
        }
    }

    #[test]
    fn in_cluster_config() {
        let root = |h: &str, p: Option<&str>| in_cluster_root(Some(h.into()), p.map(Into::into));
        assert_eq!(
            root("10.0.0.1", Some("6443")).unwrap(),
            "https://10.0.0.1:6443"
        );
        assert_eq!(root("fd00::1", None).unwrap(), "https://[fd00::1]:443");
        assert_eq!(
            in_cluster_root(None, None).unwrap_err().to_string(),
            "--kubernetes-namespace needs in-cluster config; $KUBERNETES_SERVICE_HOST is unset"
        );
    }

    #[test]
    fn config_is_checked() {
        let many = vec!["a".to_owned(); MAX_NAMESPACES + 1];
        for (namespaces, why) in [
            (many, "at most 10 --kubernetes-namespace"),
            (
                vec!["Apps".into()],
                "--kubernetes-namespace \"Apps\" is not a namespace name",
            ),
            (
                vec!["a/b".into()],
                "--kubernetes-namespace \"a/b\" is not a namespace name",
            ),
            (
                vec!["-a".into()],
                "--kubernetes-namespace \"-a\" is not a namespace name",
            ),
            (
                vec!["a".into(), "a".into()],
                "--kubernetes-namespace \"a\" is given twice",
            ),
        ] {
            assert_eq!(Config::new(namespaces).unwrap_err().to_string(), why);
        }
    }
}
