import { invoke } from '@tauri-apps/api/core';

export interface ProcessInfo {
  pid: number;
  rss_bytes: number;
  cpu_percent: number;
  user: string;
  name: string;
  command: string;
}

export const listProcesses = (): Promise<ProcessInfo[]> =>
  invoke('system_list_processes');

export const killProcess = (pid: number, force: boolean): Promise<void> =>
  invoke('system_kill_process', { pid, force });

export interface DisplayInfo {
  name: string;
  resolution: string | null;
  main: boolean;
  mirror: boolean;
}

export const listDisplays = (): Promise<DisplayInfo[]> =>
  invoke('system_list_displays');

export const sleepDisplays = (): Promise<void> => invoke('system_sleep_displays');

export const adjustBrightness = (up: boolean): Promise<void> =>
  invoke('system_adjust_brightness', { up });

export interface DisplayDevice {
  id: number;
  name: string;
  width_px: number;
  height_px: number;
  is_main: boolean;
  is_builtin: boolean;
  brightness: number | null;
  supports_brightness: boolean;
  vendor_id: number;
  model_id: number;
  /// Non-zero when this display is currently "hidden" — i.e. configured
  /// as a software mirror of another display.
  mirrors: number;
}

export const listHardwareDisplays = (): Promise<DisplayDevice[]> =>
  invoke('system_list_hardware_displays');

export const setDisplayBrightness = (id: number, value: number): Promise<void> =>
  invoke('system_set_display_brightness', { id, value });

export const setDisplayHidden = (
  secondary: number,
  master: number,
  hide: boolean,
): Promise<void> =>
  invoke('system_set_display_hidden', { secondary, master, hide });

export const powerOffDisplay = (secondary: number, master: number): Promise<void> =>
  invoke('system_power_off_display', { secondary, master });

export const powerOnDisplay = (secondary: number): Promise<void> =>
  invoke('system_power_on_display', { secondary });

export interface DisplayMode {
  index: number;
  width_points: number;
  height_points: number;
  width_pixels: number;
  height_pixels: number;
  refresh_hz: number;
  is_current: boolean;
}

export const listDisplayModes = (id: number): Promise<DisplayMode[]> =>
  invoke('system_list_display_modes', { id });

export const setDisplayMode = (id: number, index: number): Promise<void> =>
  invoke('system_set_display_mode', { id, index });

// ---- docker ----
export interface DockerUsageItem {
  kind: string;
  total: number;
  active: number;
  size_bytes: number;
  reclaimable_bytes: number;
}
export interface DockerStatus {
  installed: boolean;
  running: boolean;
  version: string | null;
  items: DockerUsageItem[];
}
export interface DockerPruneResult {
  reclaimed_bytes: number;
  stdout: string;
}
export const dockerStatus = (): Promise<DockerStatus> => invoke('system_docker_status');
export const dockerPrune = (): Promise<DockerPruneResult> => invoke('system_docker_prune');

export interface LargeFile {
  path: string;
  size_bytes: number;
  modified_secs: number;
}

export interface ScanSummary {
  scanned: number;
  files: LargeFile[];
}

export const scanLargeFiles = (
  minBytes: number,
  root?: string,
  limit?: number,
): Promise<ScanSummary> =>
  invoke('system_scan_large_files', {
    root: root ?? null,
    minBytes,
    limit: limit ?? null,
  });

export const trashPath = (path: string): Promise<void> =>
  invoke('system_trash_path', { path });

export type CacheKind = 'safe' | 'regeneratable' | 'browser';

export interface CacheEntry {
  label: string;
  path: string;
  size_bytes: number;
  kind: CacheKind;
}

export const listCaches = (): Promise<CacheEntry[]> => invoke('system_list_caches');

export type AgentScope = 'user' | 'system';

export interface LaunchAgent {
  label: string;
  path: string;
  scope: AgentScope;
  disabled: boolean;
  pid: number | null;
}

export const listLaunchAgents = (): Promise<LaunchAgent[]> =>
  invoke('system_list_launch_agents');

export const toggleLaunchAgent = (path: string, enable: boolean): Promise<void> =>
  invoke('system_toggle_launch_agent', { path, enable });

export interface Application {
  name: string;
  path: string;
  bundle_id: string | null;
  size_bytes: number;
}

export interface Leftover {
  path: string;
  size_bytes: number;
}

export const listApps = (): Promise<Application[]> => invoke('system_list_apps');

export const findLeftovers = (
  bundleId: string | null,
  appName: string,
): Promise<Leftover[]> =>
  invoke('system_find_leftovers', { bundleId, appName });

// ---- dashboard ----
export interface NetIface {
  name: string;
  kind: 'wifi' | 'ethernet' | 'vpn' | 'loopback' | 'other';
  rx_bytes: number;
  tx_bytes: number;
  is_primary: boolean;
}
export interface DashboardMetrics {
  cpu_percent: number;
  load_1m: number;
  load_5m: number;
  load_15m: number;
  mem_used_bytes: number;
  mem_total_bytes: number;
  mem_pressure_percent: number;
  disk_used_bytes: number;
  disk_total_bytes: number;
  disk_free_bytes: number;
  battery_percent: number | null;
  battery_charging: boolean | null;
  uptime_seconds: number;
  process_count: number;
  interfaces: NetIface[];
  ping_ms: number | null;
}
export const dashboardMetrics = (): Promise<DashboardMetrics> =>
  invoke('system_dashboard_metrics');

// ---- trash bins ----
export interface TrashBin {
  path: string;
  volume: string;
  size_bytes: number;
  item_count: number;
}
export const listTrashBins = (): Promise<TrashBin[]> => invoke('system_list_trash_bins');
export const emptyTrash = (): Promise<void> => invoke('system_empty_trash');

// ---- node_modules ----
export interface NodeModulesEntry {
  path: string;
  project: string;
  size_bytes: number;
  last_modified: number;
}
export const scanNodeModules = (root: string): Promise<NodeModulesEntry[]> =>
  invoke('system_scan_node_modules', { root });

// ---- disk hogs ----
export interface Screenshot {
  path: string;
  size_bytes: number;
  created_secs: number;
}
export const listScreenshots = (): Promise<Screenshot[]> =>
  invoke('system_list_screenshots');

export interface IosBackup {
  path: string;
  uuid: string;
  device_name: string | null;
  size_bytes: number;
  last_modified: number;
}
export const listIosBackups = (): Promise<IosBackup[]> =>
  invoke('system_list_ios_backups');

export interface MailAttachmentsBucket {
  version: string;
  path: string;
  size_bytes: number;
}
export const listMailAttachments = (): Promise<MailAttachmentsBucket[]> =>
  invoke('system_list_mail_attachments');

export interface XcodeSimulator {
  path: string;
  name: string;
  size_bytes: number;
  available: boolean;
}
export const listXcodeSimulators = (): Promise<XcodeSimulator[]> =>
  invoke('system_list_xcode_simulators');
export const deleteUnavailableSimulators = (): Promise<void> =>
  invoke('system_delete_unavailable_simulators');

export interface TmSnapshot {
  name: string;
  created_at: string;
}
export const listTmSnapshots = (): Promise<TmSnapshot[]> =>
  invoke('system_list_tm_snapshots');
export const deleteTmSnapshot = (name: string): Promise<void> =>
  invoke('system_delete_tm_snapshot', { name });

// ---- duplicates ----
export interface DuplicateGroup {
  size_bytes: number;
  hash: string;
  paths: string[];
}
export const findDuplicates = (
  root: string,
  minBytes?: number,
): Promise<DuplicateGroup[]> =>
  invoke('system_find_duplicates', { root, minBytes: minBytes ?? null });

// ---- battery ----
export interface BatteryHealth {
  cycle_count: number | null;
  condition: string | null;
  max_capacity_mah: number | null;
  design_capacity_mah: number | null;
  current_capacity_mah: number | null;
  present: boolean;
}
export const batteryHealth = (): Promise<BatteryHealth> =>
  invoke('system_battery_health');

// ---- quick actions ----
export const sleepNow = (): Promise<void> => invoke('system_sleep_now');
export const lockScreen = (): Promise<void> => invoke('system_lock_screen');
export const flushDns = (): Promise<void> => invoke('system_flush_dns');
export const reindexSpotlight = (): Promise<void> =>
  invoke('system_reindex_spotlight');
export const emptyMemoryPressure = (): Promise<void> =>
  invoke('system_empty_memory_pressure');

// ---- privacy ----
export interface PrivacyItem {
  label: string;
  path: string;
  size_bytes: number;
  category: string;
}
export const listPrivacy = (): Promise<PrivacyItem[]> => invoke('system_list_privacy');

// ---- cancellation ----
export type CancellableScan = 'large_files' | 'node_modules' | 'duplicates';
export const cancelScan = (kind: CancellableScan): Promise<boolean> =>
  invoke('system_cancel_scan', { kind });

// ---- network ----
export interface NetConnection {
  pid: number;
  process: string;
  protocol: string;
  local: string;
  remote: string;
  state: string;
}
export const listConnections = (): Promise<NetConnection[]> =>
  invoke('system_list_connections');
