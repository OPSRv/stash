import { invoke } from '@tauri-apps/api/core';

/** Package info for one project folder, as read by Rust. */
export interface NpmProjectInfo {
  path: string;
  name: string;
  /** Script names in package.json declaration order. */
  scripts: string[];
}

/** Validate a folder and read its package.json. Rejects with a readable
 *  message when the folder or its `scripts` object is missing. */
export const npmReadProject = (path: string) =>
  invoke<NpmProjectInfo>('npm_read_project', { path });

/** Replace the project list Rust uses to build the tray "npm scripts"
 *  submenus. */
export const npmSetProjects = (paths: string[]) =>
  invoke<unknown>('npm_set_projects', { paths });
