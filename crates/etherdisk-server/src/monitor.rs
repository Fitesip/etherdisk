//! Watches the server and tells the owner in Telegram: free space on every storage volume
//! and under the database, volumes that went missing, the indexer falling behind the
//! chain, the RPC failing, and bursts of server errors. One message when a problem
//! starts, a reminder while it lasts, one when it is over. `/status` in the chat answers
//! with the current state. Without a bot token, problems only go to the log.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use alloy::providers::Provider;
use serde_json::json;

use crate::chain::RpcChain;
use crate::volumes::{VolumeInfo, VolumeStore};
use crate::{now, AppState};

/// Reminder interval while a problem lasts.
const REMIND_SECS: i64 = 6 * 3600;

#[derive(Clone, Debug)]
pub struct Thresholds {
    /// Warn below this share of free space (percent), on volumes and under the database.
    pub free_percent: u64,
    /// Second, louder warning below this.
    pub critical_percent: u64,
    /// Warn when the indexer is this many blocks behind (≈ 12 s each).
    pub indexer_lag_blocks: u64,
    /// Warn when this many requests failed with 5xx since the previous check.
    pub errors_per_check: u64,
}

/// What a check saw.
#[derive(Debug, Default)]
pub struct Snapshot {
    pub volumes: Vec<VolumeInfo>,
    /// Volumes that hold drives but are not configured or not mounted: (id, drives).
    pub missing_volumes: Vec<(String, i64)>,
    /// Drives whose capacity couldn't be fully reserved on their volume: (token, bytes).
    pub shortages: Vec<(String, u64)>,
    /// Free and total bytes where the database lives.
    pub db_disk: Option<(PathBuf, u64, u64)>,
    /// Next block to index and the confirmed chain head, or the RPC error.
    pub indexer: Option<Result<(u64, u64), String>>,
    /// 5xx responses since the previous check.
    pub errors: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Problem {
    pub key: String,
    pub text: String,
}

fn pct(free: u64, total: u64) -> u64 {
    (free.saturating_mul(100)).checked_div(total).unwrap_or(100)
}

pub fn fmt_bytes(n: u64) -> String {
    const GB: f64 = (1u64 << 30) as f64;
    let gb = n as f64 / GB;
    if gb >= 1024.0 {
        format!("{:.2} ТБ", gb / 1024.0)
    } else {
        format!("{gb:.1} ГБ")
    }
}

/// Free and total space of one place (a volume or the database's directory).
struct Place {
    key: String,
    label: String,
    free: u64,
    total: u64,
}

/// Directories on the same disk report the same size and (almost) the same free space at
/// the same moment: they are one disk, reported once. Portable stand-in for a device id.
const SAME_DISK_SLACK: u64 = 64 << 20;

fn space_problems(out: &mut Vec<Problem>, places: Vec<Place>, t: &Thresholds) {
    let mut disks: Vec<Vec<Place>> = Vec::new();
    for p in places {
        match disks.iter_mut().find(|d| d[0].total == p.total && d[0].free.abs_diff(p.free) <= SAME_DISK_SLACK) {
            Some(d) => d.push(p),
            None => disks.push(vec![p]),
        }
    }
    for d in disks {
        let (free, total) = (d[0].free, d[0].total);
        let pc = pct(free, total);
        let key = d.iter().map(|p| p.key.as_str()).collect::<Vec<_>>().join("+");
        let what = d.iter().map(|p| p.label.as_str()).collect::<Vec<_>>().join(", ");
        // Volumes reserve their drives' capacity: free space is what no drive has been sold.
        let detail = format!("свободно (не занято и не зарезервировано за дисками) {} из {} ({pc}%)", fmt_bytes(free), fmt_bytes(total));
        if pc < t.critical_percent {
            out.push(Problem { key: format!("{key}:critical"), text: format!("🔴 Почти нет места: {what} — {detail}. Новые диски не поместятся: закройте продажи или добавьте хранилище") });
        } else if pc < t.free_percent {
            out.push(Problem { key: format!("{key}:low"), text: format!("🟠 Мало места: {what} — {detail}. Пора планировать расширение хранилища") });
        }
    }
}

/// Every problem the snapshot shows.
pub fn problems(s: &Snapshot, t: &Thresholds) -> Vec<Problem> {
    let mut out = Vec::new();
    let mut places: Vec<Place> = s
        .volumes
        .iter()
        .map(|v| Place { key: format!("volume:{}", v.id), label: format!("том {}", v.root.display()), free: v.available_bytes, total: v.total_bytes })
        .collect();
    if let Some((dir, free, total)) = &s.db_disk {
        places.push(Place { key: "db".into(), label: format!("база данных ({})", dir.display()), free: *free, total: *total });
    }
    space_problems(&mut out, places, t);
    if !s.shortages.is_empty() {
        let total: u64 = s.shortages.iter().map(|(_, b)| b).sum();
        let drives: Vec<String> = s.shortages.iter().map(|(t, b)| format!("#{t} ({})", fmt_bytes(*b))).collect();
        out.push(Problem {
            key: "reserve".into(),
            text: format!(
                "🔴 Не хватает места на резерв дисков: {} не зарезервировано ({}). Эти диски могут упереться в полный том: добавьте хранилище и закройте продажи",
                fmt_bytes(total),
                drives.join(", ")
            ),
        });
    }
    for (id, drives) in &s.missing_volumes {
        out.push(Problem {
            key: format!("missing:{id}"),
            text: format!("🔴 Том {id} недоступен (не примонтирован или убран из DATA_DIR): {drives} дисков не открываются"),
        });
    }
    match &s.indexer {
        Some(Ok((next, head))) => {
            let lag = head.saturating_sub(*next);
            if lag > t.indexer_lag_blocks {
                out.push(Problem {
                    key: "indexer".into(),
                    text: format!(
                        "🟠 Индексатор отстаёт на {lag} блоков (≈ {} мин): переводы дисков обрабатываются с задержкой",
                        lag * 12 / 60
                    ),
                });
            }
        }
        Some(Err(e)) => out.push(Problem { key: "rpc".into(), text: format!("🔴 RPC не отвечает: {e}") }),
        None => {}
    }
    if s.errors >= t.errors_per_check {
        out.push(Problem {
            key: "errors".into(),
            text: format!("🟠 {} ошибок сервера (5xx) с прошлой проверки — подробности в логе", s.errors),
        });
    }
    out
}

/// Turns the problems of each check into messages: new, still there (every few hours), over.
#[derive(Default)]
pub struct Tracker {
    /// key -> (text, last time it was sent)
    active: HashMap<String, (String, i64)>,
}

impl Tracker {
    pub fn update(&mut self, current: Vec<Problem>, now: i64) -> Vec<String> {
        let mut out = Vec::new();
        let keys: Vec<String> = current.iter().map(|p| p.key.clone()).collect();
        for (key, (text, _)) in self.active.iter() {
            if !keys.contains(key) {
                out.push(format!("✅ Исправлено: {}", strip_icon(text)));
            }
        }
        self.active.retain(|k, _| keys.contains(k));
        for p in current {
            match self.active.get_mut(&p.key) {
                None => {
                    out.push(p.text.clone());
                    self.active.insert(p.key, (p.text, now));
                }
                Some((text, sent)) => {
                    *text = p.text;
                    if now - *sent >= REMIND_SECS {
                        out.push(format!("⏰ Всё ещё: {}", strip_icon(text)));
                        *sent = now;
                    }
                }
            }
        }
        out
    }

    pub fn active(&self) -> usize {
        self.active.len()
    }
}

fn strip_icon(text: &str) -> &str {
    text.split_once(' ').map_or(text, |(_, rest)| rest)
}

/// Sends messages to one chat through the Bot API. Errors drop the URL: it holds the token.
#[derive(Clone)]
pub struct Telegram {
    client: reqwest::Client,
    /// `{api}/bot{token}`
    base: String,
    chat: String,
}

impl Telegram {
    /// `proxy`: a URL `reqwest::Proxy::all` accepts (see `Config::telegram_proxy`).
    pub fn new(api: &str, token: &str, chat: &str, proxy: Option<&str>) -> anyhow::Result<Self> {
        let mut client = reqwest::Client::builder().timeout(Duration::from_secs(70));
        if let Some(p) = proxy {
            client = client.proxy(reqwest::Proxy::all(p).map_err(|_| anyhow::anyhow!("invalid Telegram proxy URL"))?);
        }
        let client = client.build()?;
        Ok(Self { client, base: format!("{}/bot{token}", api.trim_end_matches('/')), chat: chat.to_owned() })
    }

    pub async fn send(&self, text: &str) -> anyhow::Result<()> {
        let r = self
            .client
            .post(format!("{}/sendMessage", self.base))
            .json(&json!({ "chat_id": self.chat, "text": text, "disable_web_page_preview": true }))
            .send()
            .await
            .map_err(|e| e.without_url())?;
        anyhow::ensure!(r.status().is_success(), "Telegram answered {}", r.status());
        Ok(())
    }

    /// Long-polls for new messages; returns (next offset, texts from our chat).
    async fn updates(&self, offset: i64) -> anyhow::Result<(i64, Vec<String>)> {
        let r: serde_json::Value = self
            .client
            .post(format!("{}/getUpdates", self.base))
            .json(&json!({ "offset": offset, "timeout": 50, "allowed_updates": ["message"] }))
            .send()
            .await
            .map_err(|e| e.without_url())?
            .json()
            .await
            .map_err(|e| e.without_url())?;
        let mut next = offset;
        let mut texts = Vec::new();
        for u in r["result"].as_array().into_iter().flatten() {
            next = next.max(u["update_id"].as_i64().unwrap_or(0) + 1);
            let msg = &u["message"];
            // Only our chat may ask: the bot is not a public status page.
            if msg["chat"]["id"].to_string().trim_matches('"') == self.chat {
                if let Some(t) = msg["text"].as_str() {
                    texts.push(t.to_owned());
                }
            }
        }
        Ok((next, texts))
    }
}

pub struct Monitor {
    state: AppState,
    store: Arc<VolumeStore>,
    rpc: Arc<RpcChain>,
    thresholds: Thresholds,
    telegram: Option<Telegram>,
    interval: Duration,
}

impl Monitor {
    pub fn new(state: AppState, store: Arc<VolumeStore>, rpc: Arc<RpcChain>) -> Self {
        let c = &state.config;
        let telegram = match (&c.telegram_bot_token, &c.telegram_chat_id) {
            (Some(token), Some(chat)) => match Telegram::new(&c.telegram_api_url, token, chat, c.telegram_proxy.as_deref()) {
                Ok(tg) => {
                    let via = if c.telegram_proxy.is_some() { " through TELEGRAM_PROXY" } else { "" };
                    tracing::info!(chat = %chat, "monitor: alerts go to Telegram{via}");
                    Some(tg)
                }
                Err(e) => {
                    tracing::error!("monitor: {e}: alerts go to the log only");
                    None
                }
            },
            (None, None) => {
                tracing::info!("monitor: no TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID, alerts go to the log only");
                None
            }
            (Some(_), None) => {
                tracing::warn!("monitor: TELEGRAM_BOT_TOKEN is set but TELEGRAM_CHAT_ID is not: alerts go to the log only");
                None
            }
            (None, Some(_)) => {
                tracing::warn!("monitor: TELEGRAM_CHAT_ID is set but TELEGRAM_BOT_TOKEN is not: alerts go to the log only");
                None
            }
        };
        Self {
            thresholds: c.alert_thresholds.clone(),
            interval: Duration::from_secs(c.monitor_interval_secs.max(10)),
            telegram,
            state,
            store,
            rpc,
        }
    }

    async fn snapshot(&self, errors: u64) -> Snapshot {
        let mut s = Snapshot { errors, ..Default::default() };
        match self.store.info().await {
            Ok(v) => s.volumes = v,
            Err(e) => tracing::warn!("monitor: volumes: {e}"),
        }
        s.missing_volumes = self.store.missing().await.unwrap_or_default();
        s.shortages = self.store.shortages();
        let db_dir = db_dir(&self.state.config.database_url);
        if let (Ok(free), Ok(total)) = (fs4::available_space(&db_dir), fs4::total_space(&db_dir)) {
            s.db_disk = Some((db_dir, free, total));
        }
        let next: Option<i64> = sqlx::query_scalar("SELECT next_block FROM indexer_state WHERE id = 1")
            .fetch_optional(&self.state.db)
            .await
            .ok()
            .flatten();
        let next = next.map_or(self.state.config.start_block, |n| n as u64);
        s.indexer = Some(match self.rpc.provider.get_block_number().await {
            Ok(head) => Ok((next, head.saturating_sub(self.state.config.confirmations))),
            Err(e) => Err(e.to_string().chars().take(200).collect()),
        });
        s
    }

    async fn say(&self, text: &str) {
        tracing::warn!("{text}");
        if let Some(tg) = &self.telegram {
            if let Err(e) = tg.send(text).await {
                tracing::warn!("monitor: Telegram: {e:#}");
            }
        }
    }

    pub async fn run(self: Arc<Self>) {
        if let Some(tg) = self.telegram.clone() {
            tokio::spawn(answer_status(self.clone(), tg));
        }
        let s = self.snapshot(0).await;
        if let Some(tg) = &self.telegram {
            let text = format!("🟢 Сервер Etherdisk запущен\n\n{}", status_text(&s, 0));
            if let Err(e) = tg.send(&text).await {
                tracing::warn!("monitor: Telegram: {e:#}");
            }
        }
        let mut tracker = Tracker::default();
        let mut seen_errors = self.state.server_errors.load(Ordering::Relaxed);
        loop {
            tokio::time::sleep(self.interval).await;
            let total = self.state.server_errors.load(Ordering::Relaxed);
            let s = self.snapshot(total - seen_errors).await;
            seen_errors = total;
            for msg in tracker.update(problems(&s, &self.thresholds), now()) {
                self.say(&msg).await;
            }
        }
    }
}

/// Answers `/status` in the configured chat.
async fn answer_status(m: Arc<Monitor>, tg: Telegram) {
    let mut offset = 0;
    loop {
        match tg.updates(offset).await {
            Ok((next, texts)) => {
                offset = next;
                for t in texts {
                    if t.trim().starts_with("/status") {
                        let s = m.snapshot(0).await;
                        let active = problems(&s, &m.thresholds).len();
                        if let Err(e) = tg.send(&status_text(&s, active)).await {
                            tracing::warn!("monitor: Telegram: {e:#}");
                        }
                    }
                }
            }
            Err(e) => {
                tracing::debug!("monitor: Telegram updates: {e:#}");
                tokio::time::sleep(Duration::from_secs(30)).await;
            }
        }
    }
}

pub fn status_text(s: &Snapshot, problems: usize) -> String {
    let mut lines = vec!["📊 Состояние".to_owned()];
    for v in &s.volumes {
        lines.push(format!(
            "• Том {}: свободно {} из {} ({}%), зарезервировано за дисками {}, дисков: {}",
            v.root.display(),
            fmt_bytes(v.available_bytes),
            fmt_bytes(v.total_bytes),
            pct(v.available_bytes, v.total_bytes),
            fmt_bytes(v.reserved_bytes),
            v.vaults
        ));
    }
    for (id, drives) in &s.missing_volumes {
        lines.push(format!("• Том {id}: недоступен, дисков: {drives}"));
    }
    if let Some((dir, free, total)) = &s.db_disk {
        lines.push(format!("• База ({}): свободно {} из {}", dir.display(), fmt_bytes(*free), fmt_bytes(*total)));
    }
    match &s.indexer {
        Some(Ok((next, head))) => lines.push(format!("• Индексатор: блок {next}, сеть {head}, отставание {}", head.saturating_sub(*next))),
        Some(Err(e)) => lines.push(format!("• RPC не отвечает: {e}")),
        None => {}
    }
    lines.push(if problems == 0 { "Проблем нет ✅".to_owned() } else { format!("Проблем: {problems}") });
    lines.join("\n")
}

fn db_dir(url: &str) -> PathBuf {
    let path = url.strip_prefix("sqlite://").unwrap_or(url);
    let path = path.split('?').next().unwrap_or(path);
    std::path::Path::new(path).parent().filter(|p| !p.as_os_str().is_empty()).map_or_else(|| PathBuf::from("."), PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: Thresholds = Thresholds { free_percent: 15, critical_percent: 5, indexer_lag_blocks: 300, errors_per_check: 20 };
    const GB: u64 = 1 << 30;

    fn vol(id: &str, free: u64, total: u64) -> VolumeInfo {
        VolumeInfo { id: id.into(), root: PathBuf::from(format!("/mnt/{id}")), total_bytes: total, available_bytes: free, reserved_bytes: 0, vaults: 3 }
    }

    #[test]
    fn finds_each_kind_of_problem() {
        let s = Snapshot {
            volumes: vec![vol("a", 50 * GB, 100 * GB), vol("b", 10 * GB, 100 * GB), vol("c", 2 * GB, 100 * GB)],
            missing_volumes: vec![("d".into(), 4)],
            shortages: vec![("7".into(), 3 * GB)],
            db_disk: Some((PathBuf::from("data"), 90 * GB, 100 * GB)),
            indexer: Some(Ok((1000, 1400))),
            errors: 25,
        };
        let found = problems(&s, &T);
        let keys: Vec<&str> = found.iter().map(|p| p.key.as_str()).collect();
        assert_eq!(keys, ["volume:b:low", "volume:c:critical", "reserve", "missing:d", "indexer", "errors"]);
        assert!(found[2].text.contains("#7 (3.0 ГБ)"), "{}", found[2].text);
        // A volume and the database on one disk: one message naming both.
        let shared = Snapshot {
            volumes: vec![vol("a", 2 * GB, 100 * GB)],
            db_disk: Some((PathBuf::from("data"), 2 * GB + 1024, 100 * GB)),
            ..Default::default()
        };
        let p = problems(&shared, &T);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].key, "volume:a+db:critical");
        assert!(p[0].text.contains("том /mnt/a, база данных (data)"), "{}", p[0].text);
        let healthy = Snapshot { indexer: Some(Ok((1000, 1200))), volumes: vec![vol("a", 50 * GB, 100 * GB)], ..Default::default() };
        assert!(problems(&healthy, &T).is_empty());
        let down = Snapshot { indexer: Some(Err("timeout".into())), ..Default::default() };
        assert_eq!(problems(&down, &T)[0].key, "rpc");
    }

    #[test]
    fn messages_on_start_reminder_and_end() {
        let p = |key: &str| Problem { key: key.into(), text: format!("🟠 problem {key}") };
        let mut t = Tracker::default();
        assert_eq!(t.update(vec![p("x")], 0), ["🟠 problem x"]);
        assert!(t.update(vec![p("x")], 60).is_empty(), "no repeat every minute");
        assert_eq!(t.update(vec![p("x"), p("y")], REMIND_SECS), ["⏰ Всё ещё: problem x", "🟠 problem y"]);
        assert_eq!(t.update(vec![p("y")], REMIND_SECS + 60), ["✅ Исправлено: problem x"]);
        assert_eq!(t.active(), 1);
        assert_eq!(t.update(vec![], REMIND_SECS + 120), ["✅ Исправлено: problem y"]);
    }

    #[test]
    fn formats_sizes_and_db_dir() {
        assert_eq!(fmt_bytes(512 * GB), "512.0 ГБ");
        assert_eq!(fmt_bytes(3 * 1024 * GB), "3.00 ТБ");
        assert_eq!(db_dir("sqlite://data/v4/etherdisk.db"), PathBuf::from("data/v4"));
        assert_eq!(db_dir("sqlite://etherdisk.db?mode=rwc"), PathBuf::from("."));
    }
}
