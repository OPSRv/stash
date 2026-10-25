//! Agent surface — npm scripts: `npm_list_scripts`, `npm_run_script`, `npm_stop_script`.
//!
//! Shared helpers live in `crate::modules::telegram::agent_util`.

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::modules::telegram::tools::{Tool, ToolCtx, ToolRegistry};

/// Register this module's LLM tools.
pub fn register_tools(tools: &mut ToolRegistry, _app: &tauri::AppHandle) {
    tools.register(NpmListScripts);
    tools.register(NpmRunScript);
    tools.register(NpmStopScript);
}

pub struct NpmListScripts;

#[async_trait]
impl Tool for NpmListScripts {
    fn name(&self) -> &'static str {
        "npm_list_scripts"
    }
    fn description(&self) -> &'static str {
        "List the npm projects the user configured in Settings → Terminal, \
         the scripts each package.json declares, and which scripts are \
         currently running (with the TCP ports they listen on). Call before \
         `npm_run_script` / `npm_stop_script` when unsure of the exact \
         project or script name, or to answer \"what's running / on which port\"."
    }
    fn schema(&self) -> Value {
        json!({ "type": "object", "properties": {}, "additionalProperties": false })
    }
    async fn invoke(&self, ctx: &ToolCtx, _args: Value) -> Result<Value, String> {
        let app = ctx.app.as_ref().ok_or("npm_list_scripts needs an app handle")?;
        let projects = crate::modules::npm_scripts::commands::list_projects(app);
        let runs = crate::modules::npm_scripts::runs::running(app);
        let projects: Vec<Value> = projects
            .iter()
            .map(|p| {
                let running: Vec<Value> = runs
                    .iter()
                    .filter(|r| r.project_path == p.path)
                    .map(|r| {
                        json!({ "script": r.script, "ports": r.ports, "stopping": r.stopping })
                    })
                    .collect();
                json!({
                    "path": p.path,
                    "name": p.name,
                    "scripts": p.scripts,
                    "error": p.error,
                    "running": running,
                })
            })
            .collect();
        Ok(json!({ "projects": projects }))
    }
}

pub struct NpmRunScript;

#[async_trait]
impl Tool for NpmRunScript {
    fn name(&self) -> &'static str {
        "npm_run_script"
    }
    fn description(&self) -> &'static str {
        "Run an npm script from one of the configured projects: opens the \
         Stash Terminal tab, creates a new terminal tab in the project folder \
         and runs `npm run <script>` there. `project` may be the package \
         name, the folder name or the full path; `script` must match a name \
         from `npm_list_scripts` exactly."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project": {
                    "type": "string",
                    "description": "Package name, folder name or absolute path of the project."
                },
                "script": {
                    "type": "string",
                    "description": "Script name as declared in package.json (e.g. \"dev\", \"build\")."
                }
            },
            "required": ["project", "script"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let app = ctx.app.as_ref().ok_or("npm_run_script needs an app handle")?;
        let field = |k: &str| {
            args.get(k)
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| format!("missing required field: {k}"))
        };
        let project = field("project")?;
        let script = field("script")?;
        let (name, script) =
            crate::modules::npm_scripts::commands::run_by_name(app, project, script)?;
        Ok(json!({ "ok": true, "project": name, "script": script }))
    }
}

pub struct NpmStopScript;

#[async_trait]
impl Tool for NpmStopScript {
    fn name(&self) -> &'static str {
        "npm_stop_script"
    }
    fn description(&self) -> &'static str {
        "Stop a running npm script (e.g. a dev server) started from Stash: \
         sends Ctrl+C to its terminal, escalating to SIGTERM/SIGKILL if it \
         does not exit within a few seconds. Stops every running instance \
         of that script in the project. `project` may be the package name, \
         the folder name or the full path; `script` must match exactly. \
         Use `npm_list_scripts` to see what is running."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "project": {
                    "type": "string",
                    "description": "Package name, folder name or absolute path of the project."
                },
                "script": {
                    "type": "string",
                    "description": "Script name as declared in package.json (e.g. \"dev\")."
                }
            },
            "required": ["project", "script"],
            "additionalProperties": false
        })
    }
    async fn invoke(&self, ctx: &ToolCtx, args: Value) -> Result<Value, String> {
        let app = ctx.app.as_ref().ok_or("npm_stop_script needs an app handle")?;
        let field = |k: &str| {
            args.get(k)
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| format!("missing required field: {k}"))
        };
        let project = field("project")?;
        let script = field("script")?;
        let (name, script, count) =
            crate::modules::npm_scripts::commands::stop_by_name(app, project, script)?;
        Ok(json!({ "ok": true, "project": name, "script": script, "stopping": count }))
    }
}
