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
fn timezone_rules_come_from_a_server_zoneinfo_at_least_as_new_as_the_built_in_one() {
    use oneloop::timezone::{Database, built_in_version};
    // Saved under the name UTC, these rules show whether oneloop used the file.
    let plus_three = jiff_tzdb::get("Etc/GMT-3").unwrap().1;
    let newer = "# version 2099a\n".to_owned();
    let same = format!("# version {}-rearguard\n", built_in_version());
    for (tzdata, zone, server_rules) in [
        (newer.as_str(), Some(plus_three), true),
        (same.as_str(), Some(plus_three), true),
        ("# version 2000a\n", Some(plus_three), false),
        ("# version unknown\n", Some(plus_three), false),
        (newer.as_str(), None, false),
        (newer.as_str(), Some(&b"not a zone file"[..]), false),
    ] {
        let zoneinfo = crate::support::scratch_dir();
        std::fs::write(zoneinfo.path().join("tzdata.zi"), tzdata).unwrap();
        if let Some(zone) = zone {
            std::fs::write(zoneinfo.path().join("UTC"), zone).unwrap();
        }
        let config = Config::from_os_iter(environment(&[
            ("ONELOOP_PUBLIC_URL", "https://work.example.com"),
            ("TZDIR", zoneinfo.path().to_str().unwrap()),
        ]))
        .unwrap();
        let offset = config
            .timezone
            .rules()
            .to_offset(jiff::Timestamp::UNIX_EPOCH)
            .seconds();
        assert_eq!(
            (
                offset,
                matches!(config.timezone.database(), Database::System { .. })
            ),
            (if server_rules { 3 * 3600 } else { 0 }, server_rules),
            "{tzdata:?}"
        );
    }
    // Only IANA names are timezones, whatever else the folder holds.
    let zoneinfo = crate::support::scratch_dir();
    std::fs::write(zoneinfo.path().join("tzdata.zi"), "# version 2099a\n").unwrap();
    std::fs::write(zoneinfo.path().join("localtime"), plus_three).unwrap();
    let error = Config::from_os_iter(environment(&[
        ("ONELOOP_PUBLIC_URL", "https://work.example.com"),
        ("ONELOOP_TIMEZONE", "localtime"),
        ("TZDIR", zoneinfo.path().to_str().unwrap()),
    ]))
    .unwrap_err();
    assert!(error.to_string().contains("ONELOOP_TIMEZONE"), "{error}");
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

#[test]
fn password_settings_are_opt_in_and_checked() {
    use oneloop::auth::password::PasswordPolicy;
    use oneloop::config::password_policy_from_os_iter;
    let defaults = Config::from_os_iter(environment(&[(
        "ONELOOP_PUBLIC_URL",
        "https://work.example.com",
    )]))
    .unwrap()
    .password_policy;
    assert_eq!(defaults, PasswordPolicy::default());
    assert_eq!((defaults.min_length, defaults.admin_min_length), (5, 5));

    let lists = crate::support::scratch_dir();
    let list = lists.path().join("common.txt");
    std::fs::write(&list, "password\n123456\nPASSWORD\n").unwrap();
    let list = list.to_str().unwrap();
    let policy = password_policy_from_os_iter(environment(&[
        ("ONELOOP_PASSWORD_MIN_LENGTH", "10"),
        ("ONELOOP_ADMIN_PASSWORD_MIN_LENGTH", "16"),
        ("ONELOOP_PASSWORD_BLOCKLIST", list),
        ("ONELOOP_TEMPORARY_PASSWORD_LIFETIME", "36h"),
    ]))
    .unwrap();
    assert_eq!((policy.min_length, policy.admin_min_length), (10, 16));
    assert_eq!(policy.temporary_lifetime_seconds, Some(36 * 60 * 60));
    assert_eq!(policy.blocklist.as_ref().unwrap().len(), 2);
    let policy = password_policy_from_os_iter(environment(&[
        ("ONELOOP_PASSWORD_MIN_LENGTH", "9"),
        ("ONELOOP_TEMPORARY_PASSWORD_LIFETIME", "7d"),
    ]))
    .unwrap();
    assert_eq!(policy.admin_min_length, 9, "the admin minimum follows");
    assert_eq!(policy.temporary_lifetime_seconds, Some(7 * 24 * 60 * 60));

    let oversized = lists.path().join("oversized.txt");
    std::fs::File::create(&oversized)
        .unwrap()
        .set_len(16 * 1024 * 1024 + 1)
        .unwrap();
    let missing = lists.path().join("missing.txt");
    for (entries, variable) in [
        (
            vec![("ONELOOP_PASSWORD_MIN_LENGTH", "4")],
            "ONELOOP_PASSWORD_MIN_LENGTH",
        ),
        (
            vec![("ONELOOP_PASSWORD_MIN_LENGTH", "1025")],
            "ONELOOP_PASSWORD_MIN_LENGTH",
        ),
        (
            vec![("ONELOOP_PASSWORD_MIN_LENGTH", "ten")],
            "ONELOOP_PASSWORD_MIN_LENGTH",
        ),
        (
            vec![
                ("ONELOOP_PASSWORD_MIN_LENGTH", "10"),
                ("ONELOOP_ADMIN_PASSWORD_MIN_LENGTH", "8"),
            ],
            "ONELOOP_ADMIN_PASSWORD_MIN_LENGTH",
        ),
        (
            vec![("ONELOOP_PASSWORD_BLOCKLIST", missing.to_str().unwrap())],
            "ONELOOP_PASSWORD_BLOCKLIST",
        ),
        (
            vec![("ONELOOP_PASSWORD_BLOCKLIST", oversized.to_str().unwrap())],
            "ONELOOP_PASSWORD_BLOCKLIST",
        ),
    ]
    .into_iter()
    .chain(["0d", "2w", "366d", "7", "8760h1", "-1d"].map(|value| {
        (
            vec![("ONELOOP_TEMPORARY_PASSWORD_LIFETIME", value)],
            "ONELOOP_TEMPORARY_PASSWORD_LIFETIME",
        )
    })) {
        let error = password_policy_from_os_iter(environment(&entries)).unwrap_err();
        assert_eq!(error.exit_code(), 2);
        assert!(error.to_string().contains(variable), "{entries:?}: {error}");
    }
}

#[test]
fn ai_assistant_connection_settings_are_opt_in_and_checked() {
    let with = |entries: &[(&str, &str)]| {
        let mut all = vec![("ONELOOP_PUBLIC_URL", "https://work.example.com")];
        all.extend_from_slice(entries);
        Config::from_os_iter(environment(&all))
    };
    let defaults = with(&[]).unwrap();
    assert!(defaults.mcp_redirect_schemes.is_empty());
    assert!(defaults.mcp_allowed_origins.is_empty());
    assert!(!defaults.mcp_client_metadata_documents);

    let config = with(&[
        ("ONELOOP_MCP_REDIRECT_SCHEMES", " cursor, Cursor ,com.example.app,,"),
        (
            "ONELOOP_MCP_ALLOWED_ORIGINS",
            "http://localhost:6274, https://Inspector.Example/,https://inspector.example:443,http://[::1]:8000",
        ),
        ("ONELOOP_MCP_CLIENT_METADATA_DOCUMENTS", "true"),
    ])
    .unwrap();
    assert_eq!(config.mcp_redirect_schemes, ["cursor", "com.example.app"]);
    assert_eq!(
        config.mcp_allowed_origins,
        [
            "http://localhost:6274",
            "https://inspector.example",
            "http://[::1]:8000"
        ]
    );
    assert!(config.mcp_client_metadata_documents);
    assert!(
        !with(&[("ONELOOP_MCP_CLIENT_METADATA_DOCUMENTS", "false")])
            .unwrap()
            .mcp_client_metadata_documents
    );

    let refused = [
        ("ONELOOP_MCP_REDIRECT_SCHEMES", "cursor://"),
        ("ONELOOP_MCP_REDIRECT_SCHEMES", "1password"),
        ("ONELOOP_MCP_REDIRECT_SCHEMES", "my_app"),
        ("ONELOOP_MCP_REDIRECT_SCHEMES", "https"),
        ("ONELOOP_MCP_REDIRECT_SCHEMES", "JavaScript"),
        ("ONELOOP_MCP_REDIRECT_SCHEMES", "data"),
        ("ONELOOP_MCP_REDIRECT_SCHEMES", "file"),
        ("ONELOOP_MCP_REDIRECT_SCHEMES", "web+mcp"),
        ("ONELOOP_MCP_REDIRECT_SCHEMES", "Web+Cursor"),
        ("ONELOOP_MCP_ALLOWED_ORIGINS", "*"),
        ("ONELOOP_MCP_ALLOWED_ORIGINS", "null"),
        ("ONELOOP_MCP_ALLOWED_ORIGINS", "inspector.example"),
        ("ONELOOP_MCP_ALLOWED_ORIGINS", "http://inspector.example"),
        (
            "ONELOOP_MCP_ALLOWED_ORIGINS",
            "https://inspector.example/app",
        ),
        (
            "ONELOOP_MCP_ALLOWED_ORIGINS",
            "https://inspector.example?x=1",
        ),
        (
            "ONELOOP_MCP_ALLOWED_ORIGINS",
            "https://user@inspector.example",
        ),
        ("ONELOOP_MCP_ALLOWED_ORIGINS", "chrome-extension://abcdef"),
        ("ONELOOP_MCP_CLIENT_METADATA_DOCUMENTS", "yes"),
        ("ONELOOP_MCP_CLIENT_METADATA_DOCUMENTS", "1"),
    ];
    for (variable, value) in refused {
        let error = with(&[(variable, value)]).unwrap_err();
        assert_eq!(error.exit_code(), 2);
        assert!(error.to_string().contains(variable), "{value}: {error}");
    }
}
