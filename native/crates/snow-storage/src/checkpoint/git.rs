use std::path::Path;
use std::process::Output;

use napi::bindgen_prelude::*;

use super::GitBaseline;

pub(crate) fn run_git(work_dir: &Path, args: &[&str]) -> Result<Output> {
    let mut command = snow_process::process::cmd("git");
    // `safe.directory=*` bypasses Git's dubious-ownership check
    // (CVE-2022-24765), so git works inside WSL (`\\wsl$\...`) and other
    // UNC/network paths where the repo is owned by a different user.
    command
        .args(["-c", "core.quotepath=false", "-c", "safe.directory=*"])
        .args(args)
        .current_dir(work_dir);

    command
        .output()
        .map_err(|error| Error::from_reason(format!("Failed to execute git: {error}")))
}

fn checkpoint_git_ref(checkpoint_id: &str) -> String {
    format!("refs/snow/checkpoints/{checkpoint_id}")
}

pub(crate) fn update_checkpoint_git_ref(
    checkpoint_id: &str,
    baseline: &GitBaseline,
    delete: bool,
) -> Result<()> {
    let repository_root = Path::new(&baseline.repository_root);
    let reference = checkpoint_git_ref(checkpoint_id);
    let output = if delete {
        run_git(repository_root, &["update-ref", "-d", &reference])?
    } else {
        run_git(repository_root, &["update-ref", &reference, &baseline.head])?
    };
    if output.status.success() {
        Ok(())
    } else {
        Err(Error::from_reason(format!(
            "Failed to update checkpoint Git reference: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )))
    }
}

fn git_object_spec(baseline: &GitBaseline, relative: &str) -> String {
    let repository_path = if baseline.work_dir_prefix.is_empty() {
        relative.to_string()
    } else {
        format!(
            "{}/{}",
            baseline.work_dir_prefix.trim_end_matches('/'),
            relative
        )
    };
    format!("{}:{}", baseline.head, repository_path)
}

pub(crate) fn read_git_object(baseline: &GitBaseline, relative: &str) -> Result<Option<Vec<u8>>> {
    let repository_root = Path::new(&baseline.repository_root);
    let object_spec = git_object_spec(baseline, relative);
    let output = run_git(repository_root, &["show", &object_spec])?;
    if output.status.success() {
        Ok(Some(output.stdout))
    } else {
        Ok(None)
    }
}
