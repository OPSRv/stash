use std::path::Path;
use std::sync::Arc;

use tauri::{AppHandle, Manager};

use super::package::{npm_run_command, read_project, ProjectInfo};
use super::state::{snapshot, NpmProject, NpmScriptsState};

fn load(path: &str) -> NpmProject {
    match read_project(path) {
        Ok(info) => NpmProject {
            path: info.path,
            name: info.name,
            scripts: info.scripts,
            error: None,
        },
        Err(e) => NpmProject {
            path: path.to_string(),
            name: Path::new(path)
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.to_string()),
            scripts: Vec::new(),
            error: Some(e),
        },
    }
}

/// Validate a folder and return its package name + script names.
#[tauri::command]
pub fn npm_read_project(path: String) -> Result<ProjectInfo, String> {
    read_project(&path)
}

/// Replace the configured project list. Re-reads every `package.json` and
/// rebuilds the tray menu. Called by the frontend on boot and whenever the
/// `npmProjects` setting changes.
#[tauri::command]
pub fn npm_set_projects(app: AppHandle, paths: Vec<String>) -> Result<Vec<NpmProject>, String> {
    let projects: Vec<NpmProject> = paths
        .iter()
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .map(load)
        .collect();
    let state = app
        .try_state::<Arc<NpmScriptsState>>()
        .ok_or_else(|| "npm scripts state is not initialised".to_string())?;
    *state.projects.lock().map_err(|_| "npm state poisoned".to_string())? = projects.clone();
    crate::tray::rebuild(&app);
    Ok(projects)
}

/// Current cached project list (as last pushed by `npm_set_projects`).
pub fn list_projects(app: &AppHandle) -> Vec<NpmProject> {
    app.try_state::<Arc<NpmScriptsState>>()
        .map(|s| snapshot(&s))
        .unwrap_or_default()
}

fn launch(app: &AppHandle, project: &NpmProject, script: &str) -> Result<(), String> {
    let run_id = crate::modules::terminal::commands::queue_run(
        app,
        project.path.clone(),
        npm_run_command(script),
        Some(script.to_string()),
    )?;
    super::runs::track(app, run_id, project.path.clone(), script.to_string());
    Ok(())
}

/// Tray entry point: indices refer to the cached snapshot the menu was
/// built from.
pub fn run_by_index(app: &AppHandle, project_idx: usize, script_idx: usize) -> Result<(), String> {
    let projects = list_projects(app);
    let project = projects
        .get(project_idx)
        .ok_or_else(|| "project no longer configured".to_string())?;
    let script = project
        .scripts
        .get(script_idx)
        .ok_or_else(|| "script no longer exists".to_string())?;
    launch(app, project, script)
}

/// Resolve a project by display name, folder name or full path
/// (case-insensitive) — used by the assistant tool.
pub fn find_project<'a>(projects: &'a [NpmProject], query: &str) -> Option<&'a NpmProject> {
    let q = query.trim().trim_end_matches('/');
    projects.iter().find(|p| p.path.trim_end_matches('/') == q).or_else(|| {
        projects.iter().find(|p| {
            p.name.eq_ignore_ascii_case(q)
                || Path::new(&p.path)
                    .file_name()
                    .is_some_and(|f| f.to_string_lossy().eq_ignore_ascii_case(q))
        })
    })
}

/// Resolve `project` + `script` for the assistant tools, with error
/// messages that list what is available.
fn resolve<'a>(
    projects: &'a [NpmProject],
    project: &str,
    script: &str,
) -> Result<(&'a NpmProject, &'a String), String> {
    let p = find_project(projects, project).ok_or_else(|| {
        let names: Vec<&str> = projects.iter().map(|p| p.name.as_str()).collect();
        if names.is_empty() {
            "no npm projects are configured (Settings → Terminal → npm scripts)".to_string()
        } else {
            format!("unknown project '{project}'; configured: {}", names.join(", "))
        }
    })?;
    if let Some(err) = &p.error {
        return Err(format!("project '{}' is unavailable: {err}", p.name));
    }
    let s = p
        .scripts
        .iter()
        .find(|s| s.as_str() == script.trim())
        .ok_or_else(|| {
            format!(
                "unknown script '{script}' in '{}'; available: {}",
                p.name,
                p.scripts.join(", ")
            )
        })?;
    Ok((p, s))
}

/// Assistant entry point: run `script` from the project matching `project`.
/// Returns the resolved (project name, script name).
pub fn run_by_name(app: &AppHandle, project: &str, script: &str) -> Result<(String, String), String> {
    let projects = list_projects(app);
    let (p, s) = resolve(&projects, project, script)?;
    launch(app, p, s)?;
    Ok((p.name.clone(), s.clone()))
}

/// Assistant entry point: stop every running instance of `script` in the
/// project matching `project`. Returns (project name, script name, count).
pub fn stop_by_name(
    app: &AppHandle,
    project: &str,
    script: &str,
) -> Result<(String, String, usize), String> {
    let projects = list_projects(app);
    let (p, s) = resolve(&projects, project, script)?;
    let ids: Vec<u64> = super::runs::running(app)
        .into_iter()
        .filter(|r| r.project_path == p.path && &r.script == s)
        .map(|r| r.run_id)
        .collect();
    if ids.is_empty() {
        return Err(format!("'{s}' is not running in '{}'", p.name));
    }
    for id in &ids {
        super::runs::stop(app, *id)?;
    }
    Ok((p.name.clone(), s.clone(), ids.len()))
}

/// Tray entry point: stop a run by id.
pub fn stop_by_id(app: &AppHandle, run_id: u64) -> Result<(), String> {
    super::runs::stop(app, run_id)
}

/// Tray entry point: reveal the terminal pane a run lives in.
pub fn show_by_id(app: &AppHandle, run_id: u64) -> Result<(), String> {
    use crate::modules::terminal::commands::{reveal_pane, run_pane, RunPane};
    match run_pane(app, run_id) {
        RunPane::Live { pane_id, .. } => {
            reveal_pane(app, &pane_id);
            Ok(())
        }
        _ => Err("that script's terminal is gone".into()),
    }
}
