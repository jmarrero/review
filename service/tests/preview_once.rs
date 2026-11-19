use std::time::Duration;

use serde_json::{Value, json};
use tokio::process::Command;

#[tokio::test]
async fn preview_modes_reject_fifos_without_waiting_for_a_writer() {
    let dir = tempfile::tempdir().unwrap();
    let fifo = dir.path().join("board.pipe");
    let link = dir.path().join("mounted.pipe");
    rustix::fs::mkfifoat(
        rustix::fs::CWD,
        &fifo,
        rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
    )
    .unwrap();
    std::os::unix::fs::symlink(&fifo, &link).unwrap();
    // Isolate the process: a regression to blocking filesystem open must not
    // leave a Tokio blocking worker preventing the test runtime from exiting.
    for mode in ["--board-once", "--board-config"] {
        for path in [&fifo, &link] {
            let output = tokio::time::timeout(
                Duration::from_secs(5),
                Command::new(env!("CARGO_BIN_EXE_control-app"))
                    .arg(mode)
                    .arg(path)
                    .arg("--github-token-file")
                    .arg(dir.path().join("missing-token"))
                    .kill_on_drop(true)
                    .output(),
            )
            .await
            .expect("FIFO config must not block startup or runtime shutdown")
            .unwrap();
            assert!(!output.status.success());
            assert!(output.stdout.is_empty());
            assert!(
                String::from_utf8(output.stderr)
                    .unwrap()
                    .contains("board config must be a regular file")
            );
        }
    }
}

#[tokio::test]
async fn one_shot_exits_with_json_without_a_token_or_server() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("board.json");
    std::fs::write(
        &config,
        json!({
            "operator":"operator", "bot":"robot", "dispatchRepo":"example/runner",
            "dispatchWorkflow":"dispatch.yml", "dispatchRef":"main",
            "board":{"owner":"example", "project":1}, "wip":8,
            "usage":{"repository":"example/ops", "issue":1},
            "pools":{"test":{"target":0.9,"burst":3}}, "planPools":["test"]
        })
        .to_string(),
    )
    .unwrap();
    // A missing token fails before sending requests. No built app or running
    // service is needed; an accidental fall-through to serving would time out.
    let output = tokio::time::timeout(
        Duration::from_secs(5),
        Command::new(env!("CARGO_BIN_EXE_control-app"))
            .current_dir(dir.path())
            .arg("--board-once")
            .arg(&config)
            .arg("--github-token-file")
            .arg(dir.path().join("missing-token"))
            .kill_on_drop(true)
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(!output.status.success());
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["schema"], "review-service/v1");
    assert_eq!(value["generation"], 1);
    assert_eq!(value["decision"]["complete"], false);
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("board preview incomplete")
    );
    assert!(value["decisionRefresh"]["requests"].as_u64().unwrap() <= 128);
    assert_eq!(
        std::fs::read_dir(dir.path()).unwrap().count(),
        1,
        "the preview must not persist state or create output files itself"
    );
}

#[tokio::test]
async fn one_shot_rejects_token_fifos_without_blocking_shutdown() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("board.json");
    std::fs::write(
        &config,
        json!({
            "operator":"operator", "bot":"robot", "dispatchRepo":"example/runner",
            "dispatchWorkflow":"dispatch.yml", "dispatchRef":"main",
            "board":{"owner":"example", "project":1}, "wip":8,
            "usage":{"repository":"example/ops", "issue":1},
            "pools":{"test":{"target":0.9,"burst":3}}, "planPools":["test"]
        })
        .to_string(),
    )
    .unwrap();
    let fifo = dir.path().join("token.pipe");
    let link = dir.path().join("mounted-token");
    rustix::fs::mkfifoat(
        rustix::fs::CWD,
        &fifo,
        rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
    )
    .unwrap();
    std::os::unix::fs::symlink(&fifo, &link).unwrap();
    // A subprocess keeps a regressed blocking open from hanging the test's
    // runtime shutdown. No writer ever opens either FIFO path.
    for option in ["--github-token-file", "--octo-sts-token-file"] {
        for path in [&fifo, &link] {
            let mut command = Command::new(env!("CARGO_BIN_EXE_control-app"));
            command
                .arg("--board-once")
                .arg(&config)
                .arg(option)
                .arg(path);
            if option == "--octo-sts-token-file" {
                command.args(["--octo-sts-scope=example", "--octo-sts-identity=preview"]);
            }
            let output =
                tokio::time::timeout(Duration::from_secs(5), command.kill_on_drop(true).output())
                    .await
                    .expect("token FIFO must not block preview or runtime shutdown")
                    .unwrap();
            assert!(!output.status.success());
            let value: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(value["decision"]["complete"], false);
            assert_eq!(value["decision"]["items"], json!([]));
            assert!(
                String::from_utf8(output.stderr)
                    .unwrap()
                    .contains("board preview incomplete")
            );
        }
    }
}
