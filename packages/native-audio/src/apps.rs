//! Turns audio sessions into the list of apps offered for per-app capture.
//!
//! Platform independent so it can be unit tested anywhere; the Windows code
//! feeds it the sessions and a process snapshot.
#![cfg_attr(not(windows), allow(dead_code))]

use std::collections::HashMap;

use crate::AudioApp;

pub(crate) struct ProcessInfo {
    pub parent: u32,
    /// Executable file name, e.g. "Zoom.exe".
    pub exe: String,
}

pub(crate) type ProcessTable = HashMap<u32, ProcessInfo>;

/// One audio session as reported by the audio engine.
pub(crate) struct Session {
    pub pid: u32,
    pub display_name: String,
    pub active: bool,
}

/// Walks up the parent chain while the parent runs the same executable and
/// returns the top-most such process. Browsers and Teams play audio from child
/// processes; capturing the root with its process tree covers all of them.
pub(crate) fn root_process(pid: u32, table: &ProcessTable) -> u32 {
    let Some(start) = table.get(&pid) else {
        return pid;
    };
    let exe = start.exe.to_lowercase();
    let mut root = pid;
    let mut current = start;
    // Bounded, in case recycled pids form a cycle.
    for _ in 0..64 {
        let parent = current.parent;
        if parent == 0 || parent == root || parent == pid {
            break;
        }
        match table.get(&parent) {
            Some(info) if info.exe.to_lowercase() == exe => {
                root = parent;
                current = info;
            }
            _ => break,
        }
    }
    root
}

/// The session's display name if the app set a usable one. Names starting with
/// "@" are indirect resource strings (e.g. "@%SystemRoot%\System32\AudioSrv.Dll,-202").
pub(crate) fn display_name(session_name: &str) -> Option<String> {
    let name = session_name.trim();
    (!name.is_empty() && !name.starts_with('@')).then(|| name.to_string())
}

fn exe_stem(exe: &str) -> String {
    let n = exe.len();
    if n > 4 && exe.is_char_boundary(n - 4) && exe[n - 4..].eq_ignore_ascii_case(".exe") {
        exe[..n - 4].to_string()
    } else {
        exe.to_string()
    }
}

/// Groups sessions by root process. Skips pid 0, processes that have exited
/// (not in `table`) and our own process tree. Active apps come first.
pub(crate) fn group_sessions(
    sessions: &[Session],
    table: &ProcessTable,
    own_pid: u32,
) -> Vec<AudioApp> {
    struct Entry {
        app: AudioApp,
        named: bool,
    }
    let own_root = root_process(own_pid, table);
    let mut entries: Vec<Entry> = Vec::new();
    for session in sessions {
        if session.pid == 0 || session.pid == own_pid || !table.contains_key(&session.pid) {
            continue;
        }
        let root = root_process(session.pid, table);
        if root == own_pid || root == own_root {
            continue;
        }
        let exe = table.get(&root).map(|p| p.exe.clone()).unwrap_or_default();
        let explicit = display_name(&session.display_name);
        if let Some(entry) = entries.iter_mut().find(|e| e.app.pid == root) {
            entry.app.active |= session.active;
            if let (false, Some(name)) = (entry.named, explicit) {
                entry.app.display_name = name;
                entry.named = true;
            }
            continue;
        }
        entries.push(Entry {
            named: explicit.is_some(),
            app: AudioApp {
                pid: root,
                display_name: explicit.unwrap_or_else(|| exe_stem(&exe)),
                name: exe,
                active: session.active,
            },
        });
    }
    let mut apps: Vec<AudioApp> = entries.into_iter().map(|e| e.app).collect();
    apps.sort_by(|a, b| {
        b.active.cmp(&a.active).then_with(|| {
            a.display_name
                .to_lowercase()
                .cmp(&b.display_name.to_lowercase())
        })
    });
    apps
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table(entries: &[(u32, u32, &str)]) -> ProcessTable {
        entries
            .iter()
            .map(|&(pid, parent, exe)| {
                (
                    pid,
                    ProcessInfo {
                        parent,
                        exe: exe.to_string(),
                    },
                )
            })
            .collect()
    }

    fn session(pid: u32, name: &str, active: bool) -> Session {
        Session {
            pid,
            display_name: name.to_string(),
            active,
        }
    }

    #[test]
    fn root_walks_up_while_the_executable_matches() {
        let t = table(&[
            (4, 0, "explorer.exe"),
            (100, 4, "chrome.exe"),
            (200, 100, "chrome.exe"),
            (300, 200, "CHROME.EXE"),
            (400, 300, "helper.exe"),
        ]);
        assert_eq!(root_process(300, &t), 100);
        assert_eq!(root_process(100, &t), 100);
        assert_eq!(root_process(400, &t), 400);
        assert_eq!(root_process(999, &t), 999); // unknown pid
    }

    #[test]
    fn root_walk_stops_on_cycles_and_missing_parents() {
        let t = table(&[(10, 20, "a.exe"), (20, 10, "a.exe"), (30, 77, "b.exe")]);
        let r = root_process(10, &t);
        assert!(r == 10 || r == 20);
        assert_eq!(root_process(30, &t), 30);
    }

    #[test]
    fn display_names() {
        assert_eq!(
            display_name("Microsoft Teams").as_deref(),
            Some("Microsoft Teams")
        );
        assert_eq!(display_name("  "), None);
        assert_eq!(
            display_name("@%SystemRoot%\\System32\\AudioSrv.Dll,-202"),
            None
        );
        assert_eq!(exe_stem("Zoom.EXE"), "Zoom");
        assert_eq!(exe_stem("weird"), "weird");
    }

    #[test]
    fn groups_by_root_and_skips_own_tree() {
        let t = table(&[
            (4, 0, "explorer.exe"),
            (100, 4, "chrome.exe"),
            (101, 100, "chrome.exe"),
            (102, 100, "chrome.exe"),
            (500, 4, "Zoom.exe"),
            (700, 4, "Copilot.exe"),
            (701, 700, "Copilot.exe"),
            (702, 700, "Copilot.exe"),
        ]);
        let sessions = [
            session(101, "", false),
            session(102, "", true),
            session(500, "", false),
            session(500, "Zoom Meeting", false),
            session(0, "", true),
            session(701, "", true), // our app's audio process
            session(888, "", true), // exited
        ];
        let apps = group_sessions(&sessions, &t, 702);
        assert_eq!(apps.len(), 2);
        assert_eq!(apps[0].pid, 100);
        assert_eq!(apps[0].name, "chrome.exe");
        assert_eq!(apps[0].display_name, "chrome");
        assert!(apps[0].active);
        assert_eq!(apps[1].pid, 500);
        assert_eq!(apps[1].display_name, "Zoom Meeting");
        assert!(!apps[1].active);
    }
}
