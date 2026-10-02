use super::*;
use minisign::KeyPair;
use std::io::Cursor;
use std::net::TcpListener;
use std::sync::Arc;
use tauri_plugin_updater::UpdaterExt;

fn signing_key() -> (KeyPair, String) {
    let pair = KeyPair::generate_unencrypted_keypair().unwrap();
    let key =
        base64::engine::general_purpose::STANDARD.encode(pair.pk.to_box().unwrap().into_string());
    (pair, key)
}

fn sign(pair: &KeyPair, bytes: &[u8], version: &str) -> String {
    let comment = format!("timestamp:0\tversion:{version}");
    let signature = minisign::sign(
        Some(&pair.pk),
        &pair.sk,
        Cursor::new(bytes),
        Some(&comment),
        None,
    )
    .unwrap();
    base64::engine::general_purpose::STANDARD.encode(signature.to_string())
}

#[test]
fn configuration_is_inactive_until_complete_and_valid() {
    let (_, key) = signing_key();
    let config =
        serde_json::json!({ "pubkey": key, "endpoints": ["https://example.com/latest.json"] });
    assert!(
        !UpdateState::new(None, false, false, true)
            .snapshot()
            .enabled
    );
    assert!(
        UpdateState::new(Some(&config), false, false, true)
            .snapshot()
            .enabled
    );
    assert_eq!(
        UpdateState::new(Some(&config), true, false, true)
            .snapshot()
            .reason
            .as_deref(),
        Some("development")
    );
    assert_eq!(
        UpdateState::new(Some(&config), false, true, true)
            .snapshot()
            .reason
            .as_deref(),
        Some("test")
    );
    let incomplete = serde_json::json!({ "pubkey": key, "endpoints": [] });
    assert_eq!(
        UpdateState::new(Some(&incomplete), false, false, true)
            .snapshot()
            .reason
            .as_deref(),
        Some("invalid-configuration")
    );
    let insecure =
        serde_json::json!({ "pubkey": key, "endpoints": ["http://example.com/latest.json"] });
    assert!(
        !UpdateState::new(Some(&insecure), false, false, true)
            .snapshot()
            .enabled
    );
}

#[test]
fn cached_packages_are_verified_again_before_installation() {
    let (pair, key) = signing_key();
    let bytes = b"test updater package";
    let signature = sign(&pair, bytes, "0.2.0");
    let file = cache_package(bytes).unwrap();
    let mut reader = file.reopen().unwrap();
    verify_package(&read_package(&mut reader).unwrap(), &signature, &key).unwrap();
    std::fs::write(file.path(), b"tampered package").unwrap();
    assert_eq!(
        verify_package(&read_package(&mut reader).unwrap(), &signature, &key)
            .unwrap_err()
            .code,
        "SIGNATURE"
    );
    let (_, other_key) = signing_key();
    assert_eq!(
        verify_package(bytes, &signature, &other_key)
            .unwrap_err()
            .code,
        "SIGNATURE"
    );
}

// An isolated HTTP server is only used by debug tests; production URLs remain HTTPS-only.
fn serve(
    manifest: impl FnOnce(&str) -> Value,
    package: Option<Vec<u8>>,
) -> (String, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let manifest = manifest(&url).to_string().into_bytes();
    let mut bodies = vec![manifest];
    if let Some(package) = package {
        bodies.push(package);
    }
    let task = std::thread::spawn(move || {
        for body in bodies {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            std::time::Instant::now() < deadline,
                            "updater test request timed out"
                        );
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(e) => panic!("{e}"),
                }
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut headers = Vec::new();
            let mut byte = [0];
            while !headers.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).unwrap();
                headers.push(byte[0]);
            }
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
            socket.write_all(&body).unwrap();
        }
    });
    (url, task)
}

#[tokio::test]
async fn real_tauri_download_accepts_signed_bytes_and_rejects_tampering_and_wrong_keys() {
    let (pair, key) = signing_key();
    let bytes = b"test package";
    let signature = sign(&pair, bytes, "999.0.0");
    let legacy = minisign::sign(Some(&pair.pk), &pair.sk, Cursor::new(bytes), None, None).unwrap();
    for (payload, pubkey, signature, success) in [
        (bytes.to_vec(), key.clone(), signature.clone(), true),
        (b"tampered".to_vec(), key.clone(), signature.clone(), false),
        (bytes.to_vec(), signing_key().1, signature, false),
        (
            bytes.to_vec(),
            key.clone(),
            sign(&pair, bytes, "1.0.0"),
            false,
        ),
        (
            bytes.to_vec(),
            key.clone(),
            base64::engine::general_purpose::STANDARD.encode(legacy.to_string()),
            false,
        ),
    ] {
        let (url, task) = serve(
            |url| {
                serde_json::json!({
                    "version": "999.0.0", "platforms": { "fixture": { "url": format!("{url}/package"), "signature": signature } }
                })
            },
            Some(payload),
        );
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().pubkey(pubkey).build())
            .build(crate::context())
            .unwrap();
        let update = app
            .updater_builder()
            .target("fixture")
            .endpoints(vec![url.parse().unwrap()])
            .unwrap()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap()
            .check()
            .await
            .unwrap()
            .unwrap();
        let progress = Arc::new(Mutex::new(0));
        let result = update
            .download(|n, _| *progress.lock().unwrap() += n, || {})
            .await;
        assert_eq!(result.is_ok(), success);
        if let Err(error) = result {
            assert_eq!(UpdateError::plugin(error, "DOWNLOAD").code, "SIGNATURE");
        }
        assert!(*progress.lock().unwrap() > 0);
        task.join().unwrap();
    }
}

#[tokio::test]
async fn invalid_manifest_is_rejected_without_downloading() {
    let (_, key) = signing_key();
    let (url, task) = serve(|_| serde_json::json!({ "version": "not-a-version" }), None);
    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().pubkey(key).build())
        .build(crate::context())
        .unwrap();
    assert!(
        app.updater_builder()
            .endpoints(vec![url.parse().unwrap()])
            .unwrap()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap()
            .check()
            .await
            .is_err()
    );
    task.join().unwrap();
}
