//! Etherdisk for the desktop: the site's pages, built into the app (`web/` as a static
//! export), in a native window. Files are encrypted and decrypted inside the app exactly as
//! on the site; the app talks only to the Etherdisk API, the Ethereum RPC and WalletConnect
//! (the pages' CSP). Because the pages ship with the app, a compromised web server can't
//! hand it different code.

// No console window next to the app on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod dirs;
mod share;

use std::borrow::Cow;
use std::path::Path;

use tauri::http::{header, Response, StatusCode};
use tauri::webview::NewWindowResponse;
use tauri::{Emitter, Manager, State, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

/// The scheme the pages are served from: `app://localhost` (macOS, Linux) or
/// `http://app.localhost` (Windows).
const SCHEME: &str = "app";
/// The page the app opens on: the list of drives.
const START: &str = "/drive";

fn app_url(path: &str) -> Url {
    let base = if cfg!(any(windows, target_os = "android")) {
        format!("http://{SCHEME}.localhost")
    } else {
        format!("{SCHEME}://localhost")
    };
    Url::parse(&format!("{base}{path}")).expect("valid app URL")
}

/// Whether a URL is one of the app's own pages (everything else opens in the browser).
fn is_app(url: &Url) -> bool {
    let own = app_url("/");
    url.scheme() == own.scheme() && url.host_str() == own.host_str()
}

/// The file behind a request path.
///
/// - Pages of dynamic routes are prerendered once, for the id `_` (web/src/lib/route-param.ts):
///   `/drive/7/settings` is served from `/drive/_/settings`, `/s/abc.txt` from `/s/_.txt`.
/// - The router asks for a page segment's data as `__next.<segments>.__PAGE__.txt`, which the
///   export writes as nested folders: `__next.<first>/<rest>/__PAGE__.txt`.
fn route(path: &str) -> String {
    let mut parts: Vec<String> = path.split('/').map(str::to_owned).collect();
    // ["", "drive", "7", ...]
    if parts.len() > 2
        && matches!(parts[1].as_str(), "drive" | "s")
        && !parts[2].is_empty()
        && !parts[2].starts_with("__next")
    {
        let ext = parts[2]
            .find('.')
            .map(|i| parts[2][i..].to_owned())
            .unwrap_or_default();
        parts[2] = format!("_{ext}");
    }
    if let Some(last) = parts.last_mut() {
        let pieces: Vec<&str> = last.split('.').collect();
        if pieces.len() > 3 && pieces[0] == "__next" {
            let (ext, middle) = pieces[2..].split_last().expect("more than three pieces");
            *last = format!("__next.{}/{}.{ext}", pieces[1], middle.join("/"));
        }
    }
    parts.join("/")
}

/// The pages' Content-Security-Policy, as the export wrote it into its <meta> tag; sent as a
/// header too, so it also covers what comes before the tag and forbids framing the app.
fn csp(index_html: &[u8]) -> Option<String> {
    let html = String::from_utf8_lossy(index_html);
    let start = html.find(r#"http-equiv="Content-Security-Policy" content=""#)? + 46;
    let end = start + html[start..].find('"')?;
    Some(format!(
        "{}; frame-ancestors 'none'",
        html[start..end]
            .replace("&#x27;", "'")
            .replace("&amp;", "&")
    ))
}

/// Files sent from the system that the page hasn't picked up yet (see share.rs).
#[tauri::command]
fn shared_files(shared: State<share::Shared>) -> Vec<share::Item> {
    shared.take()
}

/// A piece of a sent file, as raw bytes (an ArrayBuffer in the page).
#[tauri::command]
fn read_shared(
    shared: State<share::Shared>,
    id: String,
    offset: u64,
    len: u64,
) -> Result<tauri::ipc::Response, String> {
    shared.read(&id, offset, len).map(tauri::ipc::Response::new)
}

#[tauri::command]
fn forget_shared(shared: State<share::Shared>, ids: Vec<String>) {
    shared.forget(&ids);
}

fn main() {
    let mut context = tauri::generate_context!();
    // Data in an "Etherdisk" folder rather than ones named after the identifier (dirs.rs).
    dirs::move_old_data(&context.config().identifier);
    if let Some(dir) = dirs::app_dir() {
        context.config_mut().app.app_directories_override =
            Some(tauri::utils::config::AppDirectoriesOverride::Root(dir));
    }
    tauri::Builder::default()
        .manage(share::Shared::default())
        // A second launch brings the open window forward instead of starting another app,
        // handing over the files it was started for ("Upload to Etherdisk", "Send to").
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            if app.state::<share::Shared>().add_args(args, Path::new(&cwd)) > 0 {
                let _ = app.emit("shared-files", ());
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .register_uri_scheme_protocol(SCHEME, |ctx, request| {
            let resolver = ctx.app_handle().asset_resolver();
            let path = route(request.uri().path());
            // A missing file resolves to index.html: fine for a page, wrong for data or a script.
            let file = path.rsplit('/').next().unwrap_or("");
            let wants_data = file.contains('.') && !file.ends_with(".html");
            let asset = resolver
                .get(path.clone())
                .filter(|a| !(wants_data && a.mime_type.starts_with("text/html")));
            let (status, asset) = match asset {
                Some(a) => (StatusCode::OK, Some(a)),
                None => (StatusCode::NOT_FOUND, resolver.get("404.html".into())),
            };
            let mut response = Response::builder()
                .status(status)
                .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
                .header(header::REFERRER_POLICY, "no-referrer");
            // Not for the service worker: it keeps the policy it was installed with until its
            // own script changes, and a new version (e.g. another API address) would then
            // block its fetches. It only fetches what the pages hand it.
            if let Some(policy) = (path != "/sw.js")
                .then(|| resolver.get("index.html".into()))
                .flatten()
                .and_then(|i| csp(&i.bytes))
            {
                response = response.header(header::CONTENT_SECURITY_POLICY, policy);
            }
            match asset {
                Some(a) => response
                    .header(header::CONTENT_TYPE, a.mime_type)
                    .body(Cow::Owned(a.bytes)),
                None => response.body(Cow::Borrowed(&[][..])),
            }
            .expect("valid response")
        })
        .invoke_handler(tauri::generate_handler![
            shared_files,
            read_shared,
            forget_shared
        ])
        .setup(|app| {
            let cwd = std::env::current_dir().unwrap_or_default();
            app.state::<share::Shared>()
                .add_args(std::env::args(), &cwd);
            let handle = app.handle().clone();
            let opener = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::CustomProtocol(app_url(START)))
                .title("Etherdisk")
                .inner_size(1200.0, 800.0)
                .min_inner_size(420.0, 560.0)
                // Files dropped on the window go to the page (uploads), not to Tauri's own handler.
                .disable_drag_drop_handler()
                // Links to other sites (Etherscan, wallets, the docs) open in the browser. New-window
                // links become plain navigations first (links.js): WebView2 doesn't report them.
                .initialization_script(include_str!("links.js"))
                .on_navigation(move |url| {
                    if is_app(url) || url.scheme() == "about" {
                        return true;
                    }
                    let _ = opener.opener().open_url(url.as_str(), None::<&str>);
                    false
                })
                .on_new_window(move |url, _features| {
                    let _ = handle.opener().open_url(url.as_str(), None::<&str>);
                    NewWindowResponse::Deny
                })
                .build()?;
            Ok(())
        })
        .run(context)
        .expect("error while running Etherdisk");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dynamic_routes_map_to_the_prerendered_page() {
        assert_eq!(route("/drive/7"), "/drive/_");
        assert_eq!(route("/drive/7/settings"), "/drive/_/settings");
        assert_eq!(route("/drive/7.txt"), "/drive/_.txt");
        assert_eq!(
            route("/drive/7/__next._tree.txt"),
            "/drive/_/__next._tree.txt"
        );
        assert_eq!(route("/s/AbC-d_9"), "/s/_");
        assert_eq!(route("/drive"), "/drive");
        assert_eq!(route("/drive/__next._tree.txt"), "/drive/__next._tree.txt");
        assert_eq!(route("/__next.__PAGE__.txt"), "/__next.__PAGE__.txt");
        assert_eq!(
            route("/drive/__next.!KGFwcCk.drive.__PAGE__.txt"),
            "/drive/__next.!KGFwcCk/drive/__PAGE__.txt"
        );
        assert_eq!(
            route("/drive/7/settings/__next.!KGFwcCk.drive.$d$tokenId.settings.__PAGE__.txt"),
            "/drive/_/settings/__next.!KGFwcCk/drive/$d$tokenId/settings/__PAGE__.txt"
        );
        assert_eq!(
            route("/_next/static/chunks/a.js"),
            "/_next/static/chunks/a.js"
        );
    }

    #[test]
    fn the_policy_comes_from_the_page() {
        let page = br#"<head><meta http-equiv="Content-Security-Policy" content="default-src &#x27;self&#x27;; connect-src &#x27;self&#x27; https://etherdisk.app"/>"#;
        assert_eq!(
            csp(page).unwrap(),
            "default-src 'self'; connect-src 'self' https://etherdisk.app; frame-ancestors 'none'"
        );
        assert_eq!(csp(b"<head></head>"), None);
    }

    #[test]
    fn only_the_app_origin_stays_in_the_window() {
        assert!(is_app(&app_url("/drive/7")));
        assert!(!is_app(
            &Url::parse("https://etherscan.io/address/0x1").unwrap()
        ));
        assert!(!is_app(&Url::parse("https://etherdisk.app/drive").unwrap()));
    }
}
