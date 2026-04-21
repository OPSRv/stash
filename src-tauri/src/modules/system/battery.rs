use serde::Serialize;
use std::process::Command;

#[derive(Debug, Clone, Serialize, Default)]
pub struct BatteryHealth {
    pub cycle_count: Option<i64>,
    pub condition: Option<String>,
    pub max_capacity_mah: Option<i64>,
    pub design_capacity_mah: Option<i64>,
    pub current_capacity_mah: Option<i64>,
    pub present: bool,
}

/// Extract the battery block out of `system_profiler SPPowerDataType -json`.
/// The JSON shape differs slightly between macOS versions; we read each key
/// permissively to avoid hard-failing on a renamed property.
pub fn read_health() -> BatteryHealth {
    let out = match Command::new("system_profiler")
        .args(["SPPowerDataType", "-json"])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return BatteryHealth::default(),
    };
    let json: serde_json::Value = match serde_json::from_slice(&out.stdout) {
        Ok(v) => v,
        Err(_) => return BatteryHealth::default(),
    };
    let items = json
        .get("SPPowerDataType")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut h = BatteryHealth::default();
    for item in items {
        // The battery entry carries `sppower_battery_health_info` /
        // `sppower_battery_charge_info` sub-objects.
        if let Some(health_info) = item.get("sppower_battery_health_info") {
            h.present = true;
            h.cycle_count = health_info
                .get("sppower_battery_health_cycle_count")
                .and_then(|v| v.as_i64())
                .or_else(|| {
                    item.get("sppower_battery_health_cycle_count")
                        .and_then(|v| v.as_i64())
                });
            h.condition = health_info
                .get("sppower_battery_health")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            h.max_capacity_mah = health_info
                .get("sppower_battery_health_maximum_capacity")
                .and_then(|v| v.as_i64())
                .or_else(|| {
                    health_info
                        .get("sppower_battery_maximum_capacity")
                        .and_then(|v| v.as_i64())
                });
        }
        if let Some(charge_info) = item.get("sppower_battery_charge_info") {
            h.current_capacity_mah = charge_info
                .get("sppower_battery_current_capacity")
                .and_then(|v| v.as_i64());
            h.design_capacity_mah = charge_info
                .get("sppower_battery_full_charge_capacity")
                .and_then(|v| v.as_i64())
                .or(h.design_capacity_mah);
        }
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_health_returns_default_when_absent() {
        // We can't stub system_profiler from a unit test; this guard merely
        // proves the function doesn't panic on hosts without a battery.
        let _ = read_health();
    }
}
