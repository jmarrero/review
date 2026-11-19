# The workflow check shared by the forge repositories: actionlint and
# zizmor at the versions pinned there, and its runner-label policy (no
# ubuntu-latest). It lives in the shared actions repository, so this takes
# the path of a checkout of it rather than naming or fetching one, and runs
# what that checkout holds: FORGE_ACTIONS (a relative path is from the
# repository root, wherever this is run from), else a sibling ../actions.
# It needs cargo and docker (CONTAINER=podman for podman). CI's ci job
# reaches the same Justfile through that repository's lint action.

# Check the workflows with the forge's shared actionlint, zizmor and runner-label check
lint actions=env("FORGE_ACTIONS", justfile_directory() / ".." / "actions"):
    {{ quote(just_executable()) }} --justfile {{ quote(actions / "lint" / "Justfile") }} --working-directory {{ quote(justfile_directory()) }} check

# Typecheck, unit tests and production build
check:
    npm run check

# The control app service's tests and lints (service/README.md)
check-service:
    cargo fmt --check --manifest-path service/Cargo.toml
    cargo clippy --manifest-path service/Cargo.toml --all-targets --locked -- -D warnings
    cargo test --manifest-path service/Cargo.toml --locked

# Narrow operator-action tests
test-actions:
    node --test test/actions.test.ts
