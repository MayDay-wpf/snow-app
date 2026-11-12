use std::fs;

use napi::bindgen_prelude::*;

use super::paths::{checkpoint_dir, manifest_path};
use super::{generate_checkpoint_id, CheckpointManifest, MANIFEST_VERSION};

pub(crate) fn read_manifest(checkpoint_id: &str) -> Result<CheckpointManifest> {
    let path = manifest_path(checkpoint_id)?;
    let json = fs::read_to_string(&path).map_err(|error| {
        Error::from_reason(format!(
            "Failed to read checkpoint manifest '{}': {error}",
            path.display()
        ))
    })?;
    let manifest: CheckpointManifest = serde_json::from_str(&json).map_err(|error| {
        Error::from_reason(format!(
            "Failed to parse checkpoint manifest '{}': {error}",
            path.display()
        ))
    })?;
    if manifest.version != MANIFEST_VERSION {
        return Err(Error::from_reason(format!(
            "Unsupported checkpoint format version: {}",
            manifest.version
        )));
    }
    Ok(manifest)
}

pub(crate) fn write_manifest(checkpoint_id: &str, manifest: &CheckpointManifest) -> Result<()> {
    let directory = checkpoint_dir(checkpoint_id)?;
    fs::create_dir_all(&directory).map_err(|error| {
        Error::from_reason(format!(
            "Failed to create checkpoint directory '{}': {error}",
            directory.display()
        ))
    })?;
    let json = serde_json::to_vec(manifest).map_err(|error| {
        Error::from_reason(format!("Failed to serialize checkpoint manifest: {error}"))
    })?;
    let temporary = directory.join(format!("manifest-{}.tmp", generate_checkpoint_id()));
    fs::write(&temporary, json).map_err(|error| {
        Error::from_reason(format!(
            "Failed to write checkpoint manifest '{}': {error}",
            temporary.display()
        ))
    })?;
    fs::rename(&temporary, directory.join("manifest.json")).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        Error::from_reason(format!("Failed to publish checkpoint manifest: {error}"))
    })
}
