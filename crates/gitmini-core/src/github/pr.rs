//! `github_open_pr`: Opens the "comparative" page of GitHub for a published branch (10 "Open a PR").
//! Without lock or write; no network call (remote can be `github.com` without token).
use super::credential::{GithubHost, encode_branch_path, parse_remote_url, remote_info};
use super::{GithubOpenPrArgs, GithubOpenPrResult};
use crate::error::{AppError, AppResult, gix_err};
use crate::state::AppState;
use crate::types::OpenTarget;
use crate::write::remote::{read, remote_names, remote_urls, upstream_of, valid_branch_name};

/// URL `compare` of a branch: removes the upstream if it is GitHub, otherwise `origin`; remote name of
/// the upstream if it is on this remote, if not `branch`. `base` = GitHub base recognized (`github.com` or mock).
fn compare_url(r: &gix::Repository, base: &str, branch: &str) -> AppResult<String> {
    let host = GithubHost::from_base(base);
    let upstream = upstream_of(r, branch);
    let names = remote_names(r);
    let is_github = |name: &str| -> Option<(String, String)> {
        let (fetch, push) = remote_urls(r, name)?;
        let info = remote_info(name, &fetch, &push, base);
        let slug = info.github_slug.filter(|_| info.is_github)?;
        let web = parse_remote_url(&fetch)
            .filter(|u| host.as_ref().is_some_and(|h| h.matches(u)))?
            .web_base();
        Some((slug, web))
    };

    let mut candidates: Vec<&str> = Vec::new();
    if let Some(u) = &upstream
        && names.contains(&u.remote)
    {
        candidates.push(&u.remote);
    }
    if names.iter().any(|n| n == "origin") {
        candidates.push("origin");
    }
    let Some((remote, (slug, web))) = candidates
        .into_iter()
        .find_map(|n| is_github(n).map(|s| (n, s)))
    else {
        return Err(AppError::not_found("github-remote", "No remote GitHub."));
    };

    let remote_branch = match &upstream {
        Some(u) if u.remote == remote => u.branch().to_string(),
        _ => branch.to_string(),
    };
    let tracking = format!("refs/remotes/{remote}/{remote_branch}");
    if r.try_find_reference(tracking.as_str())
        .map_err(gix_err)?
        .is_none()
    {
        return Err(AppError::not_found(
            "remote-branch",
            format!("The {branch} branch is not published on {remote}. Push it first."),
        )
        .with_detail("name", branch));
    }
    Ok(format!(
        "{web}/{slug}/compare/{}?expand=1",
        encode_branch_path(&remote_branch)
    ))
}

pub(crate) async fn open_pr(
    state: &AppState,
    args: GithubOpenPrArgs,
) -> AppResult<GithubOpenPrResult> {
    let repo = state.repo(args.repo_id)?;
    repo.ensure_present()?;
    if !valid_branch_name(&args.branch) {
        return Err(AppError::invalid_argument(
            "branch",
            format!("Invalid branch name: \"{}\".", args.branch),
        ));
    }
    let base = state.shared.github.credential_base();
    let branch = args.branch.clone();
    let url = read(&repo, move |r| compare_url(r, &base, &branch)).await?;

    // Opening: by the path of `open_external` (journalized in `GITMINI_OPEN_URL_LOG` in built e2e), except
    // Opener injected by a test.
    if let Some(open) = state.shared.github.url_opener() {
        open(&url)?;
    } else {
        crate::repo::open_external(
            state,
            crate::repo::OpenExternalArgs {
                repo_id: Some(args.repo_id),
                target: OpenTarget::Url { url: url.clone() },
            },
        )
        .await?;
    }
    Ok(GithubOpenPrResult { url })
}
