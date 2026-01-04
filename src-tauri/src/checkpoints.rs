use std::fmt;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const ZERO_OID: &str = "0000000000000000000000000000000000000000";
const CHECKPOINT_REF_PREFIX: &str = "refs/conductor-checkpoints";

#[derive(Debug)]
pub enum CheckpointOutcome {
  Created,
  Skipped { reason: String },
}

#[derive(Debug)]
pub enum CheckpointError {
  Io(std::io::Error),
  InvalidUtf8,
  Git { command: String, message: String },
  MissingMetadata(String),
  Time(String),
}

impl fmt::Display for CheckpointError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      CheckpointError::Io(err) => write!(f, "Checkpoint IO error: {err}"),
      CheckpointError::InvalidUtf8 => write!(f, "Checkpoint git output was not valid UTF-8"),
      CheckpointError::Git { command, message } => {
        write!(f, "Checkpoint git command failed ({command}): {message}")
      }
      CheckpointError::MissingMetadata(message) => write!(f, "{message}"),
      CheckpointError::Time(message) => write!(f, "{message}"),
    }
  }
}

impl std::error::Error for CheckpointError {
  fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
    match self {
      CheckpointError::Io(err) => Some(err),
      _ => None,
    }
  }
}

struct TempDirGuard {
  path: PathBuf,
}

impl Drop for TempDirGuard {
  fn drop(&mut self) {
    let _ = fs::remove_dir_all(&self.path);
  }
}

pub fn create_checkpoint(
  repo_path: &Path,
  checkpoint_id: &str,
) -> Result<CheckpointOutcome, CheckpointError> {
  ensure_repo(repo_path)?;
  if is_merge_in_progress(repo_path)? {
    return Ok(CheckpointOutcome::Skipped {
      reason: "Merge or rebase in progress".to_string(),
    });
  }

  let head_oid = match run_git_optional(repo_path, &["rev-parse", "-q", "--verify", "HEAD"])? {
    Some(value) => value,
    None => ZERO_OID.to_string(),
  };
  if head_oid == ZERO_OID {
    return Ok(CheckpointOutcome::Skipped {
      reason: "Repository has no commits".to_string(),
    });
  }

  let index_tree = run_git(repo_path, &["write-tree"], &[], None)?;

  let temp_dir = create_temp_dir("supertree-checkpoint")?;
  let tmp_index = temp_dir.path.join("index");
  let index_env = [("GIT_INDEX_FILE", tmp_index.to_str().ok_or(CheckpointError::InvalidUtf8)?)];

  run_git(
    repo_path,
    &["read-tree", index_tree.as_str()],
    &index_env,
    None,
  )?;
  run_git(repo_path, &["add", "-A", "--", "."], &index_env, None)?;
  let worktree_tree = run_git(repo_path, &["write-tree"], &index_env, None)?;

  let now = format_timestamp()?;
  let message = format!(
    "checkpoint:{checkpoint_id}\nhead {head_oid}\nindex-tree {index_tree}\nworktree-tree {worktree_tree}\ncreated {now}\n"
  );

  let commit_oid = run_git(
    repo_path,
    &["commit-tree", worktree_tree.as_str()],
    &[
      ("GIT_AUTHOR_NAME", "Checkpointer"),
      ("GIT_AUTHOR_EMAIL", "checkpointer@noreply"),
      ("GIT_AUTHOR_DATE", now.as_str()),
      ("GIT_COMMITTER_NAME", "Checkpointer"),
      ("GIT_COMMITTER_EMAIL", "checkpointer@noreply"),
      ("GIT_COMMITTER_DATE", now.as_str()),
    ],
    Some(&message),
  )?;

  let ref_name = format!("{CHECKPOINT_REF_PREFIX}/{checkpoint_id}");
  run_git(
    repo_path,
    &["update-ref", ref_name.as_str(), commit_oid.as_str()],
    &[],
    None,
  )?;

  Ok(CheckpointOutcome::Created)
}

pub fn restore_checkpoint(repo_path: &Path, checkpoint_id: &str) -> Result<(), CheckpointError> {
  ensure_repo(repo_path)?;
  let ref_name = format!("{CHECKPOINT_REF_PREFIX}/{checkpoint_id}");
  let commit_oid =
    run_git(repo_path, &["rev-parse", "-q", "--verify", ref_name.as_str()], &[], None)?;

  let commit_body = run_git(repo_path, &["cat-file", "commit", commit_oid.as_str()], &[], None)?;
  let head_oid = extract_meta(&commit_body, "head")?;
  let index_tree = extract_meta(&commit_body, "index-tree")?;
  let worktree_tree = extract_meta(&commit_body, "worktree-tree")?;

  if head_oid == ZERO_OID {
    return Err(CheckpointError::MissingMetadata(
      "Checkpoint saved with unborn HEAD and cannot be restored".to_string(),
    ));
  }

  run_git(repo_path, &["reset", "--hard", head_oid.as_str()], &[], None)?;
  run_git(
    repo_path,
    &["read-tree", "--reset", "-u", worktree_tree.as_str()],
    &[],
    None,
  )?;
  run_git(repo_path, &["clean", "-fd"], &[], None)?;
  run_git(
    repo_path,
    &["read-tree", "--reset", index_tree.as_str()],
    &[],
    None,
  )?;

  Ok(())
}

fn ensure_repo(repo_path: &Path) -> Result<(), CheckpointError> {
  let output = run_git(repo_path, &["rev-parse", "--is-inside-work-tree"], &[], None)?;
  if output != "true" {
    return Err(CheckpointError::MissingMetadata(
      "Checkpoint requires a git worktree".to_string(),
    ));
  }
  Ok(())
}

fn is_merge_in_progress(repo_path: &Path) -> Result<bool, CheckpointError> {
  let git_dir = resolve_git_dir(repo_path)?;
  Ok(
    git_dir.join("MERGE_HEAD").exists()
      || git_dir.join("rebase-merge").is_dir()
      || git_dir.join("rebase-apply").is_dir(),
  )
}

fn resolve_git_dir(repo_path: &Path) -> Result<PathBuf, CheckpointError> {
  let output = run_git(repo_path, &["rev-parse", "--git-dir"], &[], None)?;
  let path = PathBuf::from(output);
  if path.is_absolute() {
    Ok(path)
  } else {
    Ok(repo_path.join(path))
  }
}

fn extract_meta(body: &str, key: &str) -> Result<String, CheckpointError> {
  for line in body.lines() {
    if let Some(rest) = line.strip_prefix(key) {
      let value = rest.trim();
      if !value.is_empty() {
        return Ok(value.to_string());
      }
    }
  }
  Err(CheckpointError::MissingMetadata(format!(
    "Checkpoint metadata missing: {key}"
  )))
}

fn run_git_optional(
  repo_path: &Path,
  args: &[&str],
) -> Result<Option<String>, CheckpointError> {
  let output = Command::new("git")
    .current_dir(repo_path)
    .args(args)
    .output()
    .map_err(CheckpointError::Io)?;
  if !output.status.success() {
    return Ok(None);
  }
  let stdout = String::from_utf8(output.stdout).map_err(|_| CheckpointError::InvalidUtf8)?;
  Ok(Some(stdout.trim().to_string()))
}

fn run_git(
  repo_path: &Path,
  args: &[&str],
  envs: &[(&str, &str)],
  input: Option<&str>,
) -> Result<String, CheckpointError> {
  let mut command = Command::new("git");
  command.current_dir(repo_path).args(args);
  for (key, value) in envs {
    command.env(key, value);
  }
  if input.is_some() {
    command.stdin(std::process::Stdio::piped());
  }
  let mut child = command
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped())
    .spawn()
    .map_err(CheckpointError::Io)?;
  if let Some(input) = input {
    if let Some(stdin) = child.stdin.as_mut() {
      stdin.write_all(input.as_bytes()).map_err(CheckpointError::Io)?;
    }
  }
  let output = child.wait_with_output().map_err(CheckpointError::Io)?;
  if !output.status.success() {
    let stderr = String::from_utf8_lossy(&output.stderr);
    return Err(CheckpointError::Git {
      command: format!("git {}", args.join(" ")),
      message: stderr.trim().to_string(),
    });
  }
  let stdout = String::from_utf8(output.stdout).map_err(|_| CheckpointError::InvalidUtf8)?;
  Ok(stdout.trim().to_string())
}

fn create_temp_dir(prefix: &str) -> Result<TempDirGuard, CheckpointError> {
  let base = std::env::temp_dir();
  let stamp = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map_err(|err| CheckpointError::Time(err.to_string()))?
    .as_millis();
  for attempt in 0..100 {
    let candidate = base.join(format!(
      "{prefix}-{}-{}-{}",
      std::process::id(),
      stamp,
      attempt
    ));
    match fs::create_dir(&candidate) {
      Ok(()) => return Ok(TempDirGuard { path: candidate }),
      Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
      Err(err) => return Err(CheckpointError::Io(err)),
    }
  }
  Err(CheckpointError::Time(
    "Failed to create temporary directory for checkpoint".to_string(),
  ))
}

fn format_timestamp() -> Result<String, CheckpointError> {
  let stamp = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map_err(|err| CheckpointError::Time(err.to_string()))?
    .as_secs();
  Ok(format!("{stamp}"))
}
