//! mimiapp:// — every agent mini-app on an origin of its own; the pult (app/src/mini-apps.ts) carries each request over its channel.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::http::header::{HeaderName, HeaderValue, ORIGIN};
use tauri::http::{Request as HttpRequest, Response as HttpResponse};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, State, UriSchemeContext, UriSchemeResponder, WebviewWindow, Wry};

pub const SCHEME: &str = "mimiapp";
const UPLOAD_MAX: usize = 64 * 1024 * 1024;
// WebKit hands a scheme handler every load at once (no per-host limit), so a page of a few hundred images parks them all here
const PENDING_MAX: usize = 4096;
// an upload widget starts several XHRs in one tick, all parked before the pult pulls any: room for eight at UPLOAD_MAX
const PENDING_BYTES_MAX: usize = 8 * UPLOAD_MAX;
// one app (a host) holds at most a quarter of the requests and half of the bytes, so a flood from one never shuts every other app out
const APP_PENDING_MAX: usize = PENDING_MAX / 4;
const APP_PENDING_BYTES_MAX: usize = PENDING_BYTES_MAX / 2;
// the pult answers every request or gives up long before this; it only frees what a pult page that died mid-request left behind
const BACKSTOP: Duration = Duration::from_secs(30 * 60);

struct Pending {
    host: String,
    responder: UriSchemeResponder,
    body: Vec<u8>,
    /// The body's length, still counted once app_body hands the bytes to the pult, which holds them until it replies.
    size: usize,
    since: Instant,
}

#[derive(Default)]
pub struct Apps {
    pending: Mutex<HashMap<String, Pending>>,
    attached: AtomicBool,
}

fn refuse(status: u16) -> HttpResponse<Vec<u8>> {
    if cfg!(debug_assertions) {
        eprintln!("mimiapp: refused with {status}");
    }
    HttpResponse::builder()
        .status(status)
        .header("content-type", "text/plain; charset=utf-8")
        .header("content-security-policy", "default-src 'none'")
        .header("x-content-type-options", "nosniff")
        .header("cache-control", "no-store")
        .body(status.to_string().into_bytes())
        .expect("a static response")
}

/// `host` is `<appId>.<agent pin>.<gateway tag>`; useHttpsScheme is pinned off in tauri.conf.json.
fn origin_of(host: &str) -> String {
    if cfg!(any(windows, target_os = "android")) { format!("http://{SCHEME}.{host}.localhost") } else { format!("{SCHEME}://{host}.localhost") }
}

/// Binds custom-protocol IPC to the pult's page by its browser-set Origin; postMessage IPC (Android's only path, desktop's fallback) carries page-set headers, so the invoke key gates it.
pub fn pult_only(window: &WebviewWindow, request: &Request<'_>) -> Result<(), String> {
    let page = window.url().map_err(|e| e.to_string())?;
    match request.headers().get(ORIGIN) {
        Some(origin) if origin.as_bytes() != format!("{}://{}", page.scheme(), page.authority()).as_bytes() => Err("not from the control panel".into()),
        _ => Ok(()),
    }
}

/// WebKit calls this on the main thread; every answer to a responder stays there (wry #1822: an off-thread answer can abort the app).
pub fn serve(ctx: UriSchemeContext<'_, Wry>, request: HttpRequest<Vec<u8>>, responder: UriSchemeResponder) {
    let app = ctx.app_handle();
    let apps = app.state::<Apps>();
    // wry carries a Latin-1 value (setRequestHeader("x-name", "café")) as UTF-8, which to_str() would drop
    let headers: Vec<(&str, &str)> = request.headers().iter().filter_map(|(k, v)| Some((k.as_str(), std::str::from_utf8(v.as_bytes()).ok()?))).collect();
    if cfg!(debug_assertions) {
        // what WebKit really sends on a custom scheme (Origin, Sec-Fetch-*, whether a body arrived) is part of the owner's E3 check
        eprintln!("mimiapp: {} {} body {} {headers:?}", request.method(), request.uri(), request.body().len());
    }
    // the whole authority, so a port or userinfo never mints a second origin for an app
    let host = request.uri().authority().and_then(|a| a.as_str().strip_suffix(".localhost")).unwrap_or_default().to_owned();
    let Some((app_id, gateway)) = host.split_once('.') else { return responder.respond(refuse(404)) };
    // another app's page may link here, never drive this app: its fetches and form posts name their own origin
    if request.headers().get(ORIGIN).is_some_and(|o| o.as_bytes() != origin_of(&host).as_bytes()) {
        return responder.respond(refuse(403));
    }
    // and where WebKit names the requester's site, another site's page (a foreign frame nested in any app) may navigate here, never load or send
    let cross = request.headers().get("sec-fetch-site").is_some_and(|s| s == "cross-site" || s == "same-site");
    let navigates = request.headers().get("sec-fetch-mode").is_some_and(|m| m == "navigate") && matches!(request.method().as_str(), "GET" | "HEAD");
    if cross && !navigates {
        return responder.respond(refuse(403));
    }
    if request.body().len() > UPLOAD_MAX {
        return responder.respond(refuse(413));
    }
    let Some(main) = app.get_webview_window("main").filter(|_| apps.attached.load(Ordering::Acquire)) else {
        return responder.respond(refuse(503));
    };
    let mut raw = [0u8; 16];
    if getrandom::fill(&mut raw).is_err() {
        return responder.respond(refuse(503));
    }

    let id: String = raw.iter().map(|b| format!("{b:02x}")).collect();
    let meta = serde_json::json!({
        "id": id, "app": app_id, "gateway": gateway, "method": request.method().as_str(),
        "path": request.uri().path_and_query().map_or("/", |p| p.as_str()),
        "headers": headers, "body": request.body().len(),
    });
    let size = request.body().len();
    {
        let mut pending = apps.pending.lock().unwrap();
        let (mut held, mut app_count, mut app_held) = (0, 0, 0);
        for p in pending.values() {
            held += p.size;
            if p.host == host {
                app_count += 1;
                app_held += p.size;
            }
        }
        if pending.len() >= PENDING_MAX || held + size > PENDING_BYTES_MAX || app_count >= APP_PENDING_MAX || app_held + size > APP_PENDING_BYTES_MAX {
            drop(pending);
            return responder.respond(refuse(503));
        }
        pending.insert(id.clone(), Pending { host, responder, body: request.into_body(), size, since: Instant::now() });
    }
    // eval reaches the main frame only, so a request id never lands where a mini-app could read it
    if main.eval(format!("window.__mimiApps?.({meta})")).is_err() {
        let gone = apps.pending.lock().unwrap().remove(&id);
        if let Some(p) = gone { p.responder.respond(refuse(503)); }
    }
}

#[tauri::command]
pub fn apps_attach(app: AppHandle, window: WebviewWindow, request: Request<'_>, apps: State<'_, Apps>) -> Result<String, String> {
    pult_only(&window, &request)?;
    // a reloaded pult: the frames the old page was answering went with it
    let stale: Vec<Pending> = apps.pending.lock().unwrap().drain().map(|(_, p)| p).collect();
    for p in stale { p.responder.respond(refuse(503)); }
    if !apps.attached.swap(true, Ordering::AcqRel) {
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(60));
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                let expired: HashMap<String, Pending> = {
                    let apps = handle.state::<Apps>();
                    let mut pending = apps.pending.lock().unwrap();
                    let (expired, live) = std::mem::take(&mut *pending).into_iter().partition(|(_, p)| p.since.elapsed() >= BACKSTOP);
                    *pending = live;
                    expired
                };
                for (_, p) in expired { p.responder.respond(refuse(504)); }
            });
        });
    }
    Ok(format!("{}/", origin_of("{host}")))
}

#[tauri::command]
pub fn app_body(window: WebviewWindow, request: Request<'_>, apps: State<'_, Apps>, id: String) -> Result<Response, String> {
    pult_only(&window, &request)?;
    let mut pending = apps.pending.lock().unwrap();
    let held = pending.get_mut(&id).ok_or("no such request")?;
    Ok(Response::new(std::mem::take(&mut held.body)))
}

#[tauri::command]
pub fn app_respond(window: WebviewWindow, request: Request<'_>, apps: State<'_, Apps>) -> Result<(), String> {
    pult_only(&window, &request)?;
    let (id, response) = match request.body() {
        InvokeBody::Raw(bytes) => reply(bytes)?,
        // Tauri's postMessage IPC fallback carries the bytes as a JSON number array
        InvokeBody::Json(value) => reply(&Vec::<u8>::deserialize(value).map_err(|e| e.to_string())?)?,
    };
    let held = apps.pending.lock().unwrap().remove(&id);
    if let Some(held) = held { held.responder.respond(response); }
    Ok(())
}

#[derive(Deserialize)]
struct Head {
    id: String,
    status: u16,
    headers: Vec<(String, String)>,
}

/// mini-apps.ts frames a reply as [u32 big-endian head length][head JSON][body].
fn reply(bytes: &[u8]) -> Result<(String, HttpResponse<Vec<u8>>), String> {
    let len = bytes.get(..4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize).ok_or("short reply")?;
    let rest = &bytes[4..];
    let head: Head = serde_json::from_slice(rest.get(..len).ok_or("short reply")?).map_err(|e| e.to_string())?;
    if !(200..=599).contains(&head.status) {
        return Ok((head.id, refuse(502)));
    }
    let mut response = HttpResponse::builder().status(head.status).body(rest[len..].to_vec()).map_err(|e| e.to_string())?;
    // wry's macOS responder unwraps content-type as visible ASCII (a panic aborts the app) and drops any other header that is not
    for (name, value) in &head.headers {
        let value = HeaderValue::from_str(value).ok().filter(|v| v.to_str().is_ok());
        if let (Ok(name), Some(value)) = (HeaderName::from_bytes(name.as_bytes()), value) {
            response.headers_mut().append(name, value);
        }
    }
    Ok((head.id, response))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn framed(head: &str, body: &[u8]) -> Vec<u8> {
        [&(head.len() as u32).to_be_bytes()[..], head.as_bytes(), body].concat()
    }

    #[test]
    fn a_reply_keeps_its_status_headers_and_body() {
        let head = r#"{"id":"ab","status":201,"headers":[["content-type","text/html; charset=utf-8"],["x-a","1"],["x-a","2"]]}"#;
        let (id, response) = reply(&framed(head, b"<p>hi")).unwrap();
        assert_eq!(id, "ab");
        assert_eq!(response.status(), 201);
        assert_eq!(response.headers()["content-type"], "text/html; charset=utf-8");
        assert_eq!(response.headers().get_all("x-a").iter().count(), 2);
        assert_eq!(response.body(), b"<p>hi");
    }

    #[test]
    fn a_header_wry_could_not_carry_is_dropped_not_fatal() {
        let head = r#"{"id":"ab","status":200,"headers":[["content-type","text/plain; name=café"],["bad name","x"],["x-ok","y"]]}"#;
        let (_, response) = reply(&framed(head, b"")).unwrap();
        assert!(response.headers().get("content-type").is_none());
        assert_eq!(response.headers().len(), 1);
    }

    #[test]
    fn a_status_outside_200_to_599_becomes_an_inert_502() {
        for status in [101, 103, 600, 999, 0] {
            let (id, response) = reply(&framed(&format!(r#"{{"id":"ab","status":{status},"headers":[]}}"#), b"x")).unwrap();
            assert_eq!(id, "ab");
            assert_eq!(response.status(), 502);
            assert_eq!(response.headers()["content-security-policy"], "default-src 'none'");
        }
    }

    #[test]
    fn a_short_or_garbled_reply_is_an_error() {
        assert!(reply(b"").is_err());
        assert!(reply(&[0, 0, 0, 9, b'{']).is_err());
        assert!(reply(&[0xff, 0xff, 0xff, 0xff]).is_err());
        assert!(reply(&framed("{}", b"")).is_err());
    }

    #[test]
    fn every_platform_names_the_same_host_under_localhost() {
        let origin = origin_of("files.1a2b3c4d5e");
        assert!(origin.ends_with("files.1a2b3c4d5e.localhost"));
        assert!(origin.starts_with("mimiapp://") || origin.starts_with("http://mimiapp."));
    }
}
