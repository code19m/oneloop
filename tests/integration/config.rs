use std::net::SocketAddr;

use oneloop::config::{Config, DataConfig};

fn environment(entries: &[(&str, &str)]) -> Vec<(String, String)> {
    entries
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect()
}

#[test]
fn minimal_server_configuration_has_safe_defaults() {
    let config = Config::from_os_iter(environment(&[(
        "ONELOOP_PUBLIC_URL",
        "https://work.example.com",
    )]))
    .expect("valid configuration");

    assert_eq!(config.public_url.as_str(), "https://work.example.com/");
    assert_eq!(
        config.listen,
        "127.0.0.1:8080".parse::<SocketAddr>().unwrap()
    );
    assert!(config.data_dir.is_absolute());
    assert_eq!(config.timezone.name(), "UTC");
    assert_eq!(config.storage_limit_bytes, 10 * 1024 * 1024 * 1024);
    assert_eq!(config.disk_min_free_bytes, 1024 * 1024 * 1024);
    assert!(config.trusted_proxies.is_empty());
    assert_eq!(config.log_level, tracing::Level::INFO);
}

#[test]
fn configuration_parses_sizes_proxies_and_paths() {
    let config = Config::from_os_iter(environment(&[
        ("ONELOOP_PUBLIC_URL", "http://127.0.0.1:8080"),
        ("ONELOOP_LISTEN", "0.0.0.0:9000"),
        ("ONELOOP_DATA_DIR", "var/../instance"),
        ("ONELOOP_TIMEZONE", "Asia/Tashkent"),
        ("ONELOOP_STORAGE_LIMIT", "12GB"),
        ("ONELOOP_DISK_MIN_FREE", "512MiB"),
        (
            "ONELOOP_TRUSTED_PROXIES",
            "127.0.0.1, 10.0.0.0/8,127.0.0.1/32",
        ),
        ("ONELOOP_LOG_LEVEL", "debug"),
    ]))
    .expect("valid custom configuration");

    assert_eq!(config.listen, "0.0.0.0:9000".parse::<SocketAddr>().unwrap());
    // `var` does not exist, so `..` after it names the folder above it.
    assert_eq!(
        config.data_dir,
        std::env::current_dir().unwrap().join("instance")
    );
    assert_eq!(config.timezone.name(), "Asia/Tashkent");
    assert_eq!(config.storage_limit_bytes, 12_000_000_000);
    assert_eq!(config.disk_min_free_bytes, 512 * 1024 * 1024);
    assert_eq!(config.trusted_proxies.len(), 2);
    assert_eq!(config.log_level, tracing::Level::DEBUG);
}

#[test]
fn configuration_rejects_unsafe_or_unknown_values() {
    Config::from_os_iter(environment(&[("ONELOOP_PUBLIC_URL", "http://[::1]:8080")]))
        .expect("IPv6 loopback is valid for development");

    let remote_http = Config::from_os_iter(environment(&[(
        "ONELOOP_PUBLIC_URL",
        "http://work.example.com",
    )]))
    .unwrap_err();
    assert!(remote_http.to_string().contains("loopback"));

    let prefixed_url = Config::from_os_iter(environment(&[(
        "ONELOOP_PUBLIC_URL",
        "https://work.example.com/oneloop",
    )]))
    .unwrap_err();
    assert!(prefixed_url.to_string().contains("path prefixes"));

    let unknown = Config::from_os_iter(environment(&[
        ("ONELOOP_PUBLIC_URL", "https://work.example.com"),
        ("ONELOOP_PORT", "8080"),
    ]))
    .unwrap_err();
    assert!(unknown.to_string().contains("ONELOOP_PORT"));

    let malformed_size = Config::from_os_iter(environment(&[
        ("ONELOOP_PUBLIC_URL", "https://work.example.com"),
        ("ONELOOP_STORAGE_LIMIT", "10.5GiB"),
    ]))
    .unwrap_err();
    assert!(malformed_size.to_string().contains("ONELOOP_STORAGE_LIMIT"));
}

#[test]
fn maintenance_configuration_does_not_require_public_url() {
    let config = DataConfig::from_os_iter(environment(&[("ONELOOP_DATA_DIR", "./state")]))
        .expect("maintenance only needs data path");
    assert!(config.data_dir.is_absolute());
}

#[cfg(unix)]
#[test]
fn data_dir_rejects_parent_component_after_a_broken_symbolic_link() {
    let root = crate::support::scratch_dir();
    let link = root.path().join("volume");
    std::os::unix::fs::symlink(root.path().join("unmounted/volume"), &link).unwrap();
    let error = DataConfig::from_os_iter([("ONELOOP_DATA_DIR", link.join("../data"))]).unwrap_err();
    assert!(
        error.to_string().contains("broken symbolic link"),
        "{error}"
    );
}

#[test]
fn documented_fixed_offset_timezone_workarounds_cover_current_boundaries() {
    use chrono::{Offset, TimeZone};
    for (zone, seconds) in [
        ("Etc/GMT+7", -7 * 3600),
        ("Etc/GMT+6", -6 * 3600),
        ("Etc/UTC", 0),
    ] {
        let zone: chrono_tz::Tz = zone.parse().unwrap();
        for (month, day) in [(9, 21), (11, 2)] {
            assert_eq!(
                zone.with_ymd_and_hms(2026, month, day, 0, 0, 0)
                    .unwrap()
                    .offset()
                    .fix()
                    .local_minus_utc(),
                seconds
            );
        }
    }
}
