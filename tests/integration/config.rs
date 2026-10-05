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
fn unusable_data_folders_are_configuration_errors_naming_the_setting() {
    use std::{fs, os::unix::fs::PermissionsExt};
    let scratch = crate::support::scratch_dir();
    let root = scratch.path();
    std::os::unix::fs::symlink(root.join("unmounted/volume"), root.join("broken")).unwrap();
    std::os::unix::fs::symlink(root.join("loop"), root.join("loop")).unwrap();
    fs::write(root.join("file"), "").unwrap();
    fs::create_dir(root.join("locked")).unwrap();
    fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0o000)).unwrap();
    let mut cases = vec![
        (root.join("broken/../data"), "broken symbolic link"),
        (root.join("loop/../data"), "cannot resolve"),
        (root.join("file"), "is not a folder"),
        (root.join("file/data"), "cannot open"),
    ];
    // Root may open any folder, so this case applies only to other accounts.
    if fs::read_dir(root.join("locked")).is_err() {
        cases.push((root.join("locked/data"), "cannot open"));
    }
    for (path, reason) in cases {
        let error = DataConfig::from_os_iter([("ONELOOP_DATA_DIR", path.clone())]).unwrap_err();
        assert_eq!(error.exit_code(), 2, "{error}");
        let message = error.to_string();
        assert!(
            message.contains("ONELOOP_DATA_DIR") && message.contains(reason),
            "{}: {message}",
            path.display()
        );
    }
    fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0o700)).unwrap();
}

#[test]
fn documented_fixed_offset_timezone_workarounds_cover_current_boundaries() {
    for (zone, seconds) in [
        ("Etc/GMT+7", -7 * 3600),
        ("Etc/GMT+6", -6 * 3600),
        ("Etc/UTC", 0),
    ] {
        let zone = oneloop::timezone::TimeZone::built_in(zone).unwrap();
        for (month, day) in [(9, 21), (11, 2)] {
            let midnight = jiff::civil::date(2026, month, day).at(0, 0, 0, 0);
            let zoned = midnight.to_zoned(zone.rules().clone()).unwrap();
            assert_eq!(zoned.offset().seconds(), seconds);
        }
    }
}
