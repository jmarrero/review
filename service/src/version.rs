//! Build identity, embedded by the image build rather than read from the
//! runtime environment: changing a pod's settings must not change its version.

use serde::Serialize;

#[derive(Clone, Copy, Debug, Serialize)]
pub struct Version {
    pub tag: Option<&'static str>,
    pub commit: Option<&'static str>,
}

impl Default for Version {
    fn default() -> Self {
        Self {
            tag: option_env!("REVIEW_SERVICE_TAG").filter(|s| !s.is_empty()),
            commit: option_env!("REVIEW_SERVICE_COMMIT").filter(|s| !s.is_empty()),
        }
    }
}
