use crate::application::pool::ConnectionPool;
use crate::error::{AppError, AppResult};
use crate::models::{CpuCore, MetricsSnapshot, ProcessInfo};
use chrono::Utc;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;
use tokio::task::JoinHandle;

const METRICS_SCRIPT: &str = r#"export LC_ALL=C 2>/dev/null
echo __HOST__
hostname 2>/dev/null
echo __KERNEL__
uname -r 2>/dev/null
echo __UPTIME__
cat /proc/uptime 2>/dev/null
echo __LOAD__
cat /proc/loadavg 2>/dev/null
echo __STAT__
grep -E '^cpu[0-9]* ' /proc/stat 2>/dev/null
echo __MEM__
cat /proc/meminfo 2>/dev/null
echo __NET__
cat /proc/net/dev 2>/dev/null
echo __DISK__
df -Pk / 2>/dev/null | tail -n 1
echo __PROCS__
ps -eo pid=,user=,pcpu=,pmem=,rss=,args= --sort=-pcpu 2>/dev/null | head -n 20
exit 0
"#;

#[derive(Debug, Clone, Copy, Default)]
struct CpuRaw {
    total: u64,
    idle: u64,
}

#[derive(Default)]
struct PreviousSample {
    total: Option<CpuRaw>,
    cores: HashMap<String, CpuRaw>,
    net_rx: Option<u64>,
    net_tx: Option<u64>,
    at: Option<Instant>,
}

struct Watcher {
    stop: Arc<AtomicBool>,
    handle: JoinHandle<()>,
    last: Arc<Mutex<Option<MetricsSnapshot>>>,
}

#[derive(Default)]
pub struct MetricsService {
    watchers: RwLock<HashMap<String, Watcher>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MetricsEvent {
    profile_id: String,
    snapshot: MetricsSnapshot,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MetricsErrorEvent {
    profile_id: String,
    error: String,
}

impl MetricsService {
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts a polling loop for one profile. Idempotent per profile: the UI can
    /// mount several panels without spawning duplicate collectors.
    pub async fn start(
        self: &Arc<Self>,
        profile_id: &str,
        pool: Arc<ConnectionPool>,
        app: AppHandle,
        interval_ms: u64,
    ) -> AppResult<()> {
        {
            let watchers = self.watchers.read().await;
            if watchers.contains_key(profile_id) {
                return Ok(());
            }
        }

        let interval = Duration::from_millis(interval_ms.clamp(1_000, 30_000));
        let stop = Arc::new(AtomicBool::new(false));
        let last = Arc::new(Mutex::new(None::<MetricsSnapshot>));
        let profile_id_owned = profile_id.to_string();
        let stop_flag = stop.clone();
        let last_slot = last.clone();

        let handle = tokio::spawn(async move {
            let mut previous = PreviousSample::default();

            while !stop_flag.load(Ordering::SeqCst) {
                match collect(&pool, &mut previous).await {
                    Ok(snapshot) => {
                        if let Ok(mut slot) = last_slot.lock() {
                            *slot = Some(snapshot.clone());
                        }
                        let _ = app.emit(
                            "metrics:update",
                            MetricsEvent {
                                profile_id: profile_id_owned.clone(),
                                snapshot,
                            },
                        );
                    }
                    Err(error) => {
                        let _ = app.emit(
                            "metrics:error",
                            MetricsErrorEvent {
                                profile_id: profile_id_owned.clone(),
                                error: error.to_string(),
                            },
                        );
                    }
                }

                let mut waited = Duration::ZERO;
                while waited < interval {
                    if stop_flag.load(Ordering::SeqCst) {
                        return;
                    }
                    let step = Duration::from_millis(200).min(interval - waited);
                    tokio::time::sleep(step).await;
                    waited += step;
                }
            }
        });

        self.watchers
            .write()
            .await
            .insert(profile_id.to_string(), Watcher { stop, handle, last });
        Ok(())
    }

    pub async fn stop(&self, profile_id: &str) {
        let watcher = self.watchers.write().await.remove(profile_id);
        if let Some(watcher) = watcher {
            watcher.stop.store(true, Ordering::SeqCst);
            watcher.handle.abort();
        }
    }

    pub async fn snapshot(&self, profile_id: &str) -> Option<MetricsSnapshot> {
        self.watchers
            .read()
            .await
            .get(profile_id)
            .and_then(|watcher| watcher.last.lock().ok().and_then(|slot| slot.clone()))
    }
}

async fn collect(
    pool: &Arc<ConnectionPool>,
    previous: &mut PreviousSample,
) -> AppResult<MetricsSnapshot> {
    let lease = pool.acquire().await?;
    let output = lease
        .connection()
        .exec(METRICS_SCRIPT, Duration::from_secs(10))
        .await?;

    if output.stdout.trim().is_empty() {
        return Err(AppError::Remote(format!(
            "metrics command returned no data (exit {}): {}",
            output.exit_status,
            output.stderr.trim()
        )));
    }

    let elapsed = previous.at.map(|at| at.elapsed()).unwrap_or(Duration::ZERO);
    let snapshot = parse_metrics(&output.stdout, previous, elapsed)?;
    previous.at = Some(Instant::now());
    Ok(snapshot)
}

fn collect_sections(output: &str) -> HashMap<String, Vec<String>> {
    let mut sections: HashMap<String, Vec<String>> = HashMap::new();
    let mut current = String::from("__HEAD__");
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("__") && trimmed.ends_with("__") && trimmed.len() > 4 {
            current = trimmed.trim_matches('_').to_string();
            sections.entry(current.clone()).or_default();
        } else {
            sections
                .entry(current.clone())
                .or_default()
                .push(line.to_string());
        }
    }
    sections
}

fn section<'a>(sections: &'a HashMap<String, Vec<String>>, key: &str) -> &'a [String] {
    sections.get(key).map(Vec::as_slice).unwrap_or(&[])
}

fn first(sections: &HashMap<String, Vec<String>>, key: &str) -> String {
    section(sections, key)
        .iter()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_string())
        .unwrap_or_default()
}

fn parse_cpu_line(line: &str) -> Option<(String, CpuRaw)> {
    let mut parts = line.split_whitespace();
    let name = parts.next()?.to_string();
    if !name.starts_with("cpu") {
        return None;
    }
    let values: Vec<u64> = parts.filter_map(|v| v.parse().ok()).collect();
    if values.len() < 4 {
        return None;
    }
    let total: u64 = values.iter().sum();
    let idle = values.get(3).copied().unwrap_or(0) + values.get(4).copied().unwrap_or(0);
    Some((name, CpuRaw { total, idle }))
}

fn usage_percent(previous: Option<CpuRaw>, current: CpuRaw) -> f32 {
    let Some(previous) = previous else {
        return 0.0;
    };
    let total_delta = current.total.saturating_sub(previous.total);
    let idle_delta = current.idle.saturating_sub(previous.idle);
    if total_delta == 0 {
        return 0.0;
    }
    let busy = total_delta.saturating_sub(idle_delta) as f64;
    ((busy / total_delta as f64) * 100.0).clamp(0.0, 100.0) as f32
}

fn parse_meminfo(lines: &[String]) -> HashMap<String, u64> {
    let mut values = HashMap::new();
    for line in lines {
        if let Some((key, rest)) = line.split_once(':') {
            if let Some(value) = rest.split_whitespace().next().and_then(|v| v.parse().ok()) {
                values.insert(key.trim().to_string(), value);
            }
        }
    }
    values
}

fn parse_net(lines: &[String]) -> (u64, u64) {
    let mut rx = 0u64;
    let mut tx = 0u64;
    for line in lines {
        let Some((iface, rest)) = line.split_once(':') else {
            continue;
        };
        if iface.trim() == "lo" {
            continue;
        }
        let fields: Vec<&str> = rest.split_whitespace().collect();
        if fields.len() >= 9 {
            rx = rx.saturating_add(fields[0].parse().unwrap_or(0));
            tx = tx.saturating_add(fields[8].parse().unwrap_or(0));
        }
    }
    (rx, tx)
}

fn parse_processes(lines: &[String]) -> Vec<ProcessInfo> {
    lines
        .iter()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 6 {
                return None;
            }
            Some(ProcessInfo {
                pid: parts[0].parse().ok()?,
                user: parts[1].to_string(),
                cpu: parts[2].parse().unwrap_or(0.0),
                mem: parts[3].parse().unwrap_or(0.0),
                rss_kb: parts[4].parse().unwrap_or(0),
                command: parts[5..].join(" "),
            })
        })
        .collect()
}

fn parse_metrics(
    output: &str,
    previous: &mut PreviousSample,
    elapsed: Duration,
) -> AppResult<MetricsSnapshot> {
    let sections = collect_sections(output);
    let stat_lines = section(&sections, "STAT");
    let mut cores = Vec::new();
    let mut total_now: Option<CpuRaw> = None;
    let mut next_cores: HashMap<String, CpuRaw> = HashMap::new();

    for line in stat_lines {
        let Some((name, raw)) = parse_cpu_line(line) else {
            continue;
        };
        if name == "cpu" {
            total_now = Some(raw);
            continue;
        }
        let usage = usage_percent(previous.cores.get(&name).copied(), raw);
        next_cores.insert(name.clone(), raw);
        cores.push(CpuCore {
            name: name.trim_start_matches("cpu").to_string(),
            usage: round1(usage),
        });
    }

    let cpu_total = total_now
        .map(|raw| usage_percent(previous.total, raw))
        .unwrap_or(0.0);
    if let Some(raw) = total_now {
        previous.total = Some(raw);
    }
    previous.cores = next_cores;

    let load: Vec<f64> = first(&sections, "LOAD")
        .split_whitespace()
        .take(3)
        .filter_map(|v| v.parse().ok())
        .collect();
    let uptime_secs = first(&sections, "UPTIME")
        .split_whitespace()
        .next()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0) as u64;

    let mem = parse_meminfo(section(&sections, "MEM"));
    let mem_total_kb = mem.get("MemTotal").copied().unwrap_or(0);
    let mem_available_kb = mem.get("MemAvailable").copied().unwrap_or(0);
    let swap_total_kb = mem.get("SwapTotal").copied().unwrap_or(0);
    let swap_free_kb = mem.get("SwapFree").copied().unwrap_or(0);

    let (net_rx_total, net_tx_total) = parse_net(section(&sections, "NET"));
    let seconds = elapsed.as_secs_f64().max(0.001);
    let (net_rx_bps, net_tx_bps) = match (previous.net_rx, previous.net_tx) {
        (Some(prev_rx), Some(prev_tx)) => (
            net_rx_total.saturating_sub(prev_rx) as f64 / seconds,
            net_tx_total.saturating_sub(prev_tx) as f64 / seconds,
        ),
        _ => (0.0, 0.0),
    };
    previous.net_rx = Some(net_rx_total);
    previous.net_tx = Some(net_tx_total);

    let disk_line = first(&sections, "DISK");
    let disk_fields: Vec<&str> = disk_line.split_whitespace().collect();
    let disk_total_kb = disk_fields.get(1).and_then(|v| v.parse().ok()).unwrap_or(0);
    let disk_used_kb = disk_fields.get(2).and_then(|v| v.parse().ok()).unwrap_or(0);

    let snapshot = MetricsSnapshot {
        timestamp: Utc::now().timestamp(),
        hostname: first(&sections, "HOST"),
        kernel: first(&sections, "KERNEL"),
        uptime_secs,
        load1: load.first().copied().unwrap_or(0.0),
        load5: load.get(1).copied().unwrap_or(0.0),
        load15: load.get(2).copied().unwrap_or(0.0),
        cpu_total: round1(cpu_total),
        cores,
        mem_total_kb,
        mem_used_kb: mem_total_kb.saturating_sub(mem_available_kb),
        mem_available_kb,
        swap_total_kb,
        swap_used_kb: swap_total_kb.saturating_sub(swap_free_kb),
        net_rx_bps,
        net_tx_bps,
        disk_total_kb,
        disk_used_kb,
        processes: parse_processes(section(&sections, "PROCS")),
    };

    Ok(snapshot)
}

fn round1(value: f32) -> f32 {
    (value * 10.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIRST: &str = r#"__HOST__
web-01
__KERNEL__
6.8.0
__UPTIME__
3600.42 100.0
__LOAD__
0.50 0.40 0.30 1/200 4242
__STAT__
cpu  100 0 100 800 0 0 0 0 0 0
cpu0 50 0 50 400 0 0 0 0 0 0
cpu1 50 0 50 400 0 0 0 0 0 0
__MEM__
MemTotal:       16000000 kB
MemAvailable:    8000000 kB
SwapTotal:       2000000 kB
SwapFree:        1500000 kB
__NET__
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000 0 0 0 0 0 0 0 1000 0 0 0 0 0 0 0
  eth0: 2000 0 0 0 0 0 0 0 4000 0 0 0 0 0 0 0
__DISK__
/dev/sda1 100000 40000 60000 40% /
__PROCS__
  101 root 12.5 1.5 20480 /usr/bin/nginx -g daemon
  202 deploy 3.0 0.5 4096 sshd: deploy
__HEAD__"#;

    const SECOND: &str = r#"__HOST__
web-01
__KERNEL__
6.8.0
__UPTIME__
3602.42 100.0
__LOAD__
0.60 0.45 0.35 1/200 4242
__STAT__
cpu  200 0 200 1200 0 0 0 0 0 0
cpu0 100 0 100 600 0 0 0 0 0 0
cpu1 100 0 100 600 0 0 0 0 0 0
__MEM__
MemTotal:       16000000 kB
MemAvailable:    7000000 kB
SwapTotal:       2000000 kB
SwapFree:        1400000 kB
__NET__
    lo: 3000 0 0 0 0 0 0 0 3000 0 0 0 0 0 0 0
  eth0: 4000 0 0 0 0 0 0 0 6000 0 0 0 0 0 0 0
__DISK__
/dev/sda1 100000 41000 59000 41% /
__PROCS__
  101 root 25.0 1.5 20480 /usr/bin/nginx -g daemon
__HEAD__"#;

    #[test]
    fn first_sample_has_no_rate() {
        let mut prev = PreviousSample::default();
        let snap = parse_metrics(FIRST, &mut prev, Duration::ZERO).unwrap();
        assert_eq!(snap.hostname, "web-01");
        assert_eq!(snap.cpu_total, 0.0);
        assert_eq!(snap.cores.len(), 2);
        assert_eq!(snap.mem_used_kb, 8_000_000);
        assert_eq!(snap.swap_used_kb, 500_000);
        assert_eq!(snap.net_rx_bps, 0.0);
        assert_eq!(snap.disk_total_kb, 100_000);
        assert_eq!(snap.processes.len(), 2);
        assert_eq!(snap.processes[0].command, "/usr/bin/nginx -g daemon");
    }

    #[test]
    fn second_sample_computes_cpu_and_network_rates() {
        let mut prev = PreviousSample::default();
        parse_metrics(FIRST, &mut prev, Duration::ZERO).unwrap();
        let snap = parse_metrics(SECOND, &mut prev, Duration::from_secs(2)).unwrap();

        // total delta: 600, idle delta: 400 -> 33.3% busy
        assert_eq!(snap.cpu_total, 33.3);
        // rx delta 2000 bytes over 2s, tx delta 2000 over 2s
        assert_eq!(snap.net_rx_bps, 1000.0);
        assert_eq!(snap.net_tx_bps, 1000.0);
        assert_eq!(snap.mem_used_kb, 9_000_000);
        assert_eq!(snap.swap_used_kb, 600_000);
        assert_eq!(snap.disk_used_kb, 41_000);
        assert_eq!(snap.processes[0].cpu, 25.0);
    }

    #[test]
    fn busy_cpu_is_computed_from_deltas() {
        let mut prev = PreviousSample::default();
        parse_metrics(FIRST, &mut prev, Duration::ZERO).unwrap();
        let busy = r#"__STAT__
cpu  300 0 300 800 0 0 0 0 0 0
cpu0 150 0 150 400 0 0 0 0 0 0
cpu1 150 0 150 400 0 0 0 0 0 0
__HEAD__"#;
        let snap = parse_metrics(busy, &mut prev, Duration::from_secs(1)).unwrap();
        // delta total 800, delta idle 0 -> 100%
        assert_eq!(snap.cpu_total, 100.0);
    }

    #[test]
    fn parses_meminfo_units() {
        let values = parse_meminfo(&["MemTotal: 123 kB".to_string()]);
        assert_eq!(values.get("MemTotal"), Some(&123));
    }
}
