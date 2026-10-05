use super::*;
use std::net::{Ipv4Addr, Ipv6Addr};

use tokio::io::{AsyncReadExt, AsyncWriteExt};

const CLIENT_ID: &str = "https://app.example.com/oauth/client.json";

fn accept_https_or_loopback(value: &str) -> AppResult<String> {
    super::super::oauth::validate_redirect_uri(value, &[])
}

#[test]
fn client_ids_must_be_canonical_https_urls_at_a_domain() {
    assert_eq!(document_url(CLIENT_ID).unwrap().as_str(), CLIENT_ID);
    for refused in [
        "http://app.example.com/client.json",
        "https://app.example.com",
        "https://app.example.com/",
        "https://app.example.com:8443/client.json",
        "https://user:secret@app.example.com/client.json",
        "https://app.example.com/client.json?version=2",
        "https://app.example.com/client.json#top",
        "https://app.example.com/a/../client.json",
        "https://app.example.com/./client.json",
        "https://App.Example.com/client.json",
        "https://app.example.com:443/client.json",
        "https://127.0.0.1/client.json",
        "https://[::1]/client.json",
        "https://10.0.0.8/client.json",
        "olc_0123",
    ] {
        assert!(document_url(refused).is_err(), "{refused}");
    }
    let long = format!("https://app.example.com/{}", "a".repeat(500));
    assert!(document_url(&long).is_err());
}

#[test]
fn only_public_addresses_are_fetched() {
    for public in [
        IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1)),
        IpAddr::V4(Ipv4Addr::new(93, 184, 215, 14)),
        IpAddr::V4(Ipv4Addr::new(100, 63, 255, 255)),
        IpAddr::V4(Ipv4Addr::new(100, 128, 0, 0)),
        IpAddr::V4(Ipv4Addr::new(172, 32, 0, 1)),
        IpAddr::V6("2606:4700::1111".parse().unwrap()),
        IpAddr::V6("2a00:1450:4001::1".parse().unwrap()),
    ] {
        assert!(public_address(public), "{public}");
    }
    for special in [
        "0.0.0.0",
        "10.1.2.3",
        "100.64.0.1",
        "127.0.0.1",
        "127.255.255.254",
        "169.254.169.254",
        "172.16.0.1",
        "172.31.255.255",
        "192.0.0.8",
        "192.0.2.1",
        "192.88.99.1",
        "192.168.1.1",
        "198.18.0.1",
        "198.51.100.1",
        "203.0.113.1",
        "224.0.0.1",
        "239.255.255.250",
        "240.0.0.1",
        "255.255.255.255",
        "::",
        "::1",
        "::ffff:127.0.0.1",
        "::ffff:8.8.8.8",
        "::127.0.0.1",
        "64:ff9b::a00:1",
        "64:ff9b:1::1",
        "100::1",
        "2001::1",
        "2001:2::1",
        "2001:db8::1",
        "2002:a00:1::1",
        "3fff::1",
        "fc00::1",
        "fd12:3456::1",
        "fe80::1",
        "fec0::1",
        "ff02::1",
    ] {
        let address: IpAddr = special.parse().unwrap();
        assert!(!public_address(address), "{special}");
    }
    assert!(!public_address(IpAddr::V6(Ipv6Addr::LOCALHOST)));
}

#[tokio::test]
async fn names_that_resolve_to_this_computer_are_refused() {
    let url = Url::parse("https://localhost/client.json").unwrap();
    let error = fetch(&url).await.unwrap_err();
    assert!(error.to_string().contains("isn't public"), "{error}");
}

#[tokio::test]
#[ignore = "needs outgoing HTTPS; run by hand"]
async fn a_real_fetch_reads_a_small_json_document_over_tls() {
    let url = Url::parse("https://accounts.google.com/.well-known/openid-configuration").unwrap();
    let (bytes, lifetime) = fetch(&url).await.unwrap();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["issuer"], "https://accounts.google.com");
    assert!((SHORTEST_CACHE..=LONGEST_CACHE).contains(&lifetime));
    // A page that isn't JSON is refused after the TLS exchange.
    let page = Url::parse("https://example.com/client.json").unwrap();
    assert!(fetch(&page).await.is_err());
}

fn document(fields: Value) -> Vec<u8> {
    let mut document = serde_json::json!({
        "client_id": CLIENT_ID,
        "client_name": "Example Assistant",
        "redirect_uris": ["http://127.0.0.1:3000/callback", "https://app.example.com/callback"],
        "token_endpoint_auth_method": "none",
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "client_uri": "https://app.example.com",
        "logo_uri": "https://app.example.com/logo.png",
    });
    for (key, value) in fields.as_object().unwrap() {
        if value.is_null() {
            document.as_object_mut().unwrap().remove(key);
        } else {
            document[key] = value.clone();
        }
    }
    serde_json::to_vec(&document).unwrap()
}

#[test]
fn documents_must_describe_a_public_client_with_safe_callbacks() {
    let parsed = parse_document(
        CLIENT_ID,
        &document(serde_json::json!({})),
        accept_https_or_loopback,
    )
    .unwrap();
    assert_eq!(parsed.client_name, "Example Assistant");
    assert_eq!(
        parsed.redirect_uris,
        [
            "http://127.0.0.1:3000/callback",
            "https://app.example.com/callback"
        ]
    );
    assert_eq!(
        parsed.client_uri.as_deref(),
        Some("https://app.example.com/")
    );
    let minimal = parse_document(
        CLIENT_ID,
        &document(serde_json::json!({
            "token_endpoint_auth_method": null, "grant_types": null,
            "response_types": null, "client_uri": null,
        })),
        accept_https_or_loopback,
    )
    .unwrap();
    assert_eq!(minimal.client_uri, None);
    for (fields, reason) in [
        (
            serde_json::json!({"client_id": "https://other.example.com/client.json"}),
            "names another client_id",
        ),
        (
            serde_json::json!({"client_secret": "shared"}),
            "contains a client secret",
        ),
        (
            serde_json::json!({"client_secret_expires_at": 0}),
            "contains a client secret",
        ),
        (
            serde_json::json!({"token_endpoint_auth_method": "client_secret_basic"}),
            "other than none",
        ),
        (
            serde_json::json!({"token_endpoint_auth_method": "private_key_jwt"}),
            "other than none",
        ),
        (
            serde_json::json!({"grant_types": ["client_credentials"]}),
            "unsupported grant_types",
        ),
        (
            serde_json::json!({"response_types": ["token"]}),
            "unsupported response_types",
        ),
        (serde_json::json!({"client_name": null}), "client_name"),
        (serde_json::json!({"client_name": "  "}), "client_name"),
        (
            serde_json::json!({"client_name": "x".repeat(101)}),
            "client_name",
        ),
        (
            serde_json::json!({"client_name": "Line\nbreak"}),
            "client_name",
        ),
        (serde_json::json!({"redirect_uris": []}), "redirect_uris"),
        (
            serde_json::json!({"redirect_uris": vec!["https://a.example/1"; 11]}),
            "redirect_uris",
        ),
        (
            serde_json::json!({"redirect_uris": ["javascript:alert(1)"]}),
            "redirect URI",
        ),
        (
            serde_json::json!({"redirect_uris": ["http://evil.example/callback"]}),
            "redirect URI",
        ),
        (serde_json::json!({"redirect_uris": [7]}), "redirect URI"),
        (
            serde_json::json!({"client_uri": "http://app.example.com"}),
            "client_uri",
        ),
    ] {
        let error = parse_document(
            CLIENT_ID,
            &document(fields.clone()),
            accept_https_or_loopback,
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains(reason), "{fields}: {error}");
    }
    for broken in [&b"[]"[..], b"not json", b"\"text\""] {
        assert!(parse_document(CLIENT_ID, broken, accept_https_or_loopback).is_err());
    }
}

#[test]
fn responses_must_be_small_json_without_redirects() {
    let headers = |pairs: &[(&str, &str)]| {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.append(
                header::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                value.parse().unwrap(),
            );
        }
        map
    };
    let json = headers(&[("content-type", "application/json; charset=utf-8")]);
    assert_eq!(
        check_response(StatusCode::OK, &json).unwrap(),
        DEFAULT_CACHE
    );
    assert!(
        check_response(
            StatusCode::OK,
            &headers(&[("content-type", "application/client-metadata+json")])
        )
        .is_ok()
    );
    for status in [
        StatusCode::MOVED_PERMANENTLY,
        StatusCode::FOUND,
        StatusCode::TEMPORARY_REDIRECT,
    ] {
        let error = check_response(status, &json).unwrap_err().to_string();
        assert!(error.contains("redirects are not followed"), "{error}");
    }
    assert!(check_response(StatusCode::NOT_FOUND, &json).is_err());
    assert!(check_response(StatusCode::OK, &headers(&[("content-type", "text/html")])).is_err());
    assert!(check_response(StatusCode::OK, &HeaderMap::new()).is_err());
    assert!(
        check_response(
            StatusCode::OK,
            &headers(&[
                ("content-type", "application/json"),
                ("content-length", "5121")
            ])
        )
        .is_err()
    );
    for (value, lifetime) in [
        ("max-age=120", Duration::from_secs(120)),
        ("public, max-age=5", SHORTEST_CACHE),
        ("max-age=86400", LONGEST_CACHE),
        ("no-store", SHORTEST_CACHE),
        ("max-age=900, no-cache", SHORTEST_CACHE),
    ] {
        assert_eq!(
            cache_lifetime(&headers(&[("cache-control", value)])),
            lifetime,
            "{value}"
        );
    }
}

/// Serves one scripted HTTP response on an in-memory connection.
async fn served(response: Vec<u8>) -> AppResult<(Vec<u8>, Duration)> {
    let (client, mut server) = tokio::io::duplex(64 * 1024);
    tokio::spawn(async move {
        let mut request = vec![0; 4096];
        let read = server.read(&mut request).await.unwrap();
        let request = String::from_utf8_lossy(&request[..read]).into_owned();
        assert!(
            request.starts_with("GET /oauth/client.json HTTP/1.1\r\n"),
            "{request}"
        );
        assert!(
            request
                .to_ascii_lowercase()
                .contains("host: app.example.com\r\n")
        );
        let _ = server.write_all(&response).await;
        let _ = server.shutdown().await;
    });
    exchange(client, &Url::parse(CLIENT_ID).unwrap()).await
}

fn response(head: &str, body: &[u8]) -> Vec<u8> {
    let mut bytes = format!("HTTP/1.1 {head}\r\n\r\n").into_bytes();
    bytes.extend_from_slice(body);
    bytes
}

#[tokio::test]
async fn an_exchange_reads_one_bounded_response() {
    let body = document(serde_json::json!({}));
    let (bytes, lifetime) = served(response(
        &format!(
            "200 OK\r\nContent-Type: application/json\r\nCache-Control: max-age=300\r\nContent-Length: {}",
            body.len()
        ),
        &body,
    ))
    .await
    .unwrap();
    assert_eq!(bytes, body);
    assert_eq!(lifetime, Duration::from_secs(300));
    let error = served(response(
        "302 Found\r\nLocation: http://169.254.169.254/latest\r\nContent-Length: 0",
        b"",
    ))
    .await
    .unwrap_err();
    assert!(error.to_string().contains("redirects are not followed"));
    // Without a length, the body is cut off once it passes the limit.
    let oversized = vec![b' '; MAX_DOCUMENT_BYTES + 1];
    let error = served(response(
        "200 OK\r\nContent-Type: application/json\r\nConnection: close",
        &oversized,
    ))
    .await
    .unwrap_err();
    assert!(error.to_string().contains("larger than 5 KiB"), "{error}");
}

#[tokio::test]
async fn documents_are_used_only_when_turned_on_and_the_cache_is_bounded() {
    let off = ClientDocuments::new(false);
    assert!(
        off.document("alice", CLIENT_ID, accept_https_or_loopback)
            .await
            .is_err()
    );
    let on = ClientDocuments::new(true);
    let template = parse_document(
        CLIENT_ID,
        &document(serde_json::json!({})),
        accept_https_or_loopback,
    )
    .unwrap();
    on.insert_for_test(template.clone());
    assert_eq!(
        on.document("alice", CLIENT_ID, accept_https_or_loopback)
            .await
            .unwrap(),
        template
    );
    for index in 0..CACHE_ENTRIES + 10 {
        on.remember(
            ClientDocument {
                client_id: format!("https://app{index}.example.com/client.json"),
                ..template.clone()
            },
            DEFAULT_CACHE,
        );
    }
    assert!(on.cache.lock().unwrap().len() <= CACHE_ENTRIES);
}

#[test]
fn each_person_gets_a_share_of_the_fetches() {
    let documents = ClientDocuments::new(true);
    for _ in 0..FETCHES_PER_PERSON_MINUTE {
        documents.spend_fetch("mallory").unwrap();
    }
    assert!(matches!(
        documents.spend_fetch("mallory"),
        Err(AppError::RateLimited { .. })
    ));
    // Others can still connect their apps, within the server's limit.
    let mut people = 0;
    while documents.spend_fetch(&format!("person-{people}")).is_ok() {
        people += 1;
    }
    assert_eq!(
        people,
        (FETCHES_PER_MINUTE - FETCHES_PER_PERSON_MINUTE) as usize
    );
    assert!(matches!(
        documents.spend_fetch("alice"),
        Err(AppError::Unavailable(_))
    ));
}
