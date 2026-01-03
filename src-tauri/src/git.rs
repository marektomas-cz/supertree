use serde::Deserialize;
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Parsed scripts configuration from `supertree.json`.
#[derive(Debug, Clone, Default)]
pub struct RepoScripts {
  pub setup: Option<String>,
  pub run: Option<String>,
  pub archive: Option<String>,
  pub run_script_mode: Option<String>,
}

/// Basic git metadata used when adding repositories.
#[derive(Debug, Clone)]
pub struct RepoIdentity {
  pub root_path: PathBuf,
  pub name: String,
  pub remote_url: Option<String>,
  pub default_branch: String,
}

#[derive(Debug)]
pub enum GitError {
  Io(std::io::Error),
  InvalidUtf8,
  CommandFailed { command: String, message: String },
  Parse(String),
  MissingPath(String),
}

impl fmt::Display for GitError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      GitError::Io(err) => write!(f, "Git IO error: {err}"),
      GitError::InvalidUtf8 => write!(f, "Git output was not valid UTF-8"),
      GitError::CommandFailed { command, message } => {
        write!(f, "Git command failed ({command}): {message}")
      }
      GitError::Parse(message) => write!(f, "Git config parse error: {message}"),
      GitError::MissingPath(message) => write!(f, "Git path error: {message}"),
    }
  }
}

impl std::error::Error for GitError {
  fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
    match self {
      GitError::Io(err) => Some(err),
      _ => None,
    }
  }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SupertreeConfig {
  scripts: Option<SupertreeScripts>,
  run_script_mode: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SupertreeScripts {
  setup: Option<String>,
  run: Option<String>,
  archive: Option<String>,
}

/// Resolve the repository root using git.
pub fn resolve_repo_root(path: &Path) -> Result<PathBuf, GitError> {
  let output = run_git(&[
    "-C",
    path.to_str().ok_or(GitError::InvalidUtf8)?,
    "rev-parse",
    "--show-toplevel",
  ])?;
  Ok(PathBuf::from(output))
}

/// Validate that the provided path is inside a git repository.
pub fn is_git_repo(path: &Path) -> Result<bool, GitError> {
  let output = run_git(&[
    "-C",
    path.to_str().ok_or(GitError::InvalidUtf8)?,
    "rev-parse",
    "--is-inside-work-tree",
  ])?;
  Ok(output == "true")
}

/// Inspect repository metadata for the given path.
pub fn inspect_repo(path: &Path) -> Result<RepoIdentity, GitError> {
  let root_path = resolve_repo_root(path)?;
  let name = repo_name_from_path(&root_path).unwrap_or_else(|| "repository".to_string());
  let remote_url = detect_remote_url(&root_path)?;
  let default_branch = detect_default_branch(&root_path);

  Ok(RepoIdentity {
    root_path,
    name,
    remote_url,
    default_branch,
  })
}

/// Clone a repository into the target directory.
pub fn clone_repo(url: &str, target_dir: &Path) -> Result<(), GitError> {
  if url.trim().is_empty() {
    return Err(GitError::MissingPath("Git URL is required".to_string()));
  }
  let output = Command::new("git")
    .arg("clone")
    .arg(url)
    .arg(target_dir)
    .output()
    .map_err(GitError::Io)?;
  if !output.status.success() {
    let stderr = String::from_utf8_lossy(&output.stderr);
    return Err(GitError::CommandFailed {
      command: "git clone".to_string(),
      message: if stderr.trim().is_empty() {
        format!("exit code {:?}", output.status.code())
      } else {
        stderr.trim().to_string()
      },
    });
  }
  Ok(())
}

/// Parse scripts configuration from `supertree.json` if present.
pub fn read_supertree_config(path: &Path) -> Result<Option<RepoScripts>, GitError> {
  let config_path = path.join("supertree.json");
  if !config_path.exists() {
    return Ok(None);
  }
  let content = std::fs::read_to_string(&config_path).map_err(GitError::Io)?;
  let parsed: SupertreeConfig =
    serde_json::from_str(&content).map_err(|err| GitError::Parse(err.to_string()))?;
  let scripts = parsed.scripts.unwrap_or(SupertreeScripts {
    setup: None,
    run: None,
    archive: None,
  });
  Ok(Some(RepoScripts {
    setup: scripts.setup,
    run: scripts.run,
    archive: scripts.archive,
    run_script_mode: parsed.run_script_mode,
  }))
}

/// Derive a repository name from a local path.
pub fn repo_name_from_path(path: &Path) -> Option<String> {
  path.file_name()
    .and_then(|name| name.to_str())
    .map(|name| name.to_string())
}

/// Derive a repository name from a git URL.
pub fn repo_name_from_url(url: &str) -> String {
  let trimmed = url.trim_end_matches('/');
  let last_segment = trimmed
    .rsplit_once('/')
    .or_else(|| trimmed.rsplit_once(':'))
    .map(|(_, segment)| segment)
    .unwrap_or(trimmed);
  last_segment.trim_end_matches(".git").to_string()
}

/// List local branches for a repository.
pub fn list_branches(path: &Path) -> Result<Vec<String>, GitError> {
  let output = run_git(&[
    "-C",
    path.to_str().ok_or(GitError::InvalidUtf8)?,
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ])?;
  Ok(
    output
      .lines()
      .map(|line| line.trim())
      .filter(|line| !line.is_empty())
      .map(|line| line.to_string())
      .collect(),
  )
}

/// Check if a branch exists locally.
pub fn branch_exists(path: &Path, branch: &str) -> Result<bool, GitError> {
  if branch.trim().is_empty() {
    return Ok(false);
  }
  let branches = list_branches(path)?;
  Ok(branches.iter().any(|name| name == branch))
}

/// Create a git worktree for the given branch.
pub fn create_worktree(repo_path: &Path, workspace_path: &Path, branch: &str) -> Result<(), GitError> {
  let repo_str = repo_path.to_str().ok_or(GitError::InvalidUtf8)?;
  let workspace_str = workspace_path.to_str().ok_or(GitError::InvalidUtf8)?;
  run_git(&["-C", repo_str, "worktree", "add", workspace_str, branch])?;
  Ok(())
}

/// Remove a git worktree.
pub fn remove_worktree(repo_path: &Path, workspace_path: &Path) -> Result<(), GitError> {
  let repo_str = repo_path.to_str().ok_or(GitError::InvalidUtf8)?;
  let workspace_str = workspace_path.to_str().ok_or(GitError::InvalidUtf8)?;
  run_git(&[
    "-C",
    repo_str,
    "worktree",
    "remove",
    "--force",
    workspace_str,
  ])?;
  Ok(())
}

/// Configure sparse checkout patterns for a worktree.
pub fn set_sparse_checkout(worktree_path: &Path, patterns: &[String]) -> Result<(), GitError> {
  let worktree_str = worktree_path.to_str().ok_or(GitError::InvalidUtf8)?;
  if patterns.is_empty() {
    run_git(&["-C", worktree_str, "sparse-checkout", "disable"])?;
    return Ok(());
  }
  let mut args = vec![
    "-C".to_string(),
    worktree_str.to_string(),
    "sparse-checkout".to_string(),
    "set".to_string(),
  ];
  for pattern in patterns {
    let trimmed = pattern.trim();
    if !trimmed.is_empty() {
      args.push(trimmed.to_string());
    }
  }
  if args.len() == 4 {
    return Err(GitError::MissingPath(
      "Sparse checkout requires at least one pattern".to_string(),
    ));
  }
  let arg_refs: Vec<&str> = args.iter().map(|value| value.as_str()).collect();
  run_git(&arg_refs)?;
  Ok(())
}

fn detect_remote_url(path: &Path) -> Result<Option<String>, GitError> {
  let remotes = run_git(&[
    "-C",
    path.to_str().ok_or(GitError::InvalidUtf8)?,
    "remote",
  ])?;
  if !remotes.lines().any(|line| line.trim() == "origin") {
    return Ok(None);
  }
  let url = run_git(&[
    "-C",
    path.to_str().ok_or(GitError::InvalidUtf8)?,
    "remote",
    "get-url",
    "origin",
  ])?;
  Ok(Some(url))
}

fn detect_default_branch(path: &Path) -> String {
  let path_str = match path.to_str() {
    Some(value) => value,
    None => return "main".to_string(),
  };
  let origin_head = match run_git(&[
    "-C",
    path_str,
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]) {
    Ok(value) => value.strip_prefix("origin/").map(|value| value.to_string()),
    Err(err) => {
      eprintln!(
        "Failed to resolve origin/HEAD for {}: {}",
        path.display(),
        err
      );
      None
    }
  };
  if let Some(branch) = origin_head {
    return branch;
  }
  match run_git(&["-C", path_str, "symbolic-ref", "--short", "HEAD"]) {
    Ok(branch) => branch,
    Err(err) => {
      eprintln!("Failed to resolve HEAD for {}: {}", path.display(), err);
      "main".to_string()
    }
  }
}

fn run_git(args: &[&str]) -> Result<String, GitError> {
  let output = Command::new("git")
    .args(args)
    .output()
    .map_err(GitError::Io)?;
  if !output.status.success() {
    let stderr = String::from_utf8(output.stderr).map_err(|_| GitError::InvalidUtf8)?;
    return Err(GitError::CommandFailed {
      command: format!("git {}", args.join(" ")),
      message: stderr.trim().to_string(),
    });
  }
  let stdout = String::from_utf8(output.stdout).map_err(|_| GitError::InvalidUtf8)?;
  Ok(stdout.trim().to_string())
}
