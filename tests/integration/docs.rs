//! The documentation site names every configuration variable, command and MCP
//! tool the binary offers, and the quick start's compose file matches the one
//! in deploy/.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use clap::CommandFactory;
use oneloop::cli::Cli;
use serde_json::json;

use crate::mcp::{McpClient, authorize, fixture, issue, register};

fn read(relative: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()))
}

/// Environment variable names declared as `const NAME: &str = "ONELOOP_..."`
/// in src/config.rs.
fn configuration_variables() -> Vec<String> {
    let variables = read("src/config.rs")
        .lines()
        .filter_map(|line| {
            let (declaration, value) = line.trim().split_once(": &str = \"")?;
            let name = value.strip_suffix("\";")?;
            (declaration.contains("const ") && name.starts_with("ONELOOP_"))
                .then(|| name.to_owned())
        })
        .collect::<Vec<_>>();
    for known in [
        oneloop::config::PUBLIC_URL_ENV,
        oneloop::config::DATA_DIR_ENV,
        oneloop::config::LOG_LEVEL_ENV,
    ] {
        assert!(
            variables.iter().any(|name| name == known),
            "src/config.rs parsing missed {known}"
        );
    }
    variables
}

/// Every command path, such as `serve`, `user` and `user add`.
fn command_paths(command: &clap::Command, prefix: &str, paths: &mut Vec<String>) {
    for subcommand in command.get_subcommands() {
        let path = format!("{prefix}{}", subcommand.get_name());
        paths.push(path.clone());
        command_paths(subcommand, &format!("{path} "), paths);
    }
}

/// Rows of the first Markdown table after `heading`, split into trimmed cells.
fn table_rows<'a>(docs: &'a str, heading: &str) -> Vec<Vec<&'a str>> {
    let section = docs
        .split_once(heading)
        .unwrap_or_else(|| panic!("missing heading {heading:?}"))
        .1;
    section
        .lines()
        .skip_while(|line| !line.starts_with('|'))
        .take_while(|line| line.starts_with('|'))
        .skip(2)
        .map(|line| line.trim_matches('|').split('|').map(str::trim).collect())
        .collect()
}

#[test]
fn configuration_reference_names_every_environment_variable() {
    let docs = read("docs/src/configuration.md");
    let missing = configuration_variables()
        .into_iter()
        .filter(|name| !docs.contains(&format!("`{name}`")))
        .collect::<Vec<_>>();
    assert!(
        missing.is_empty(),
        "docs/src/configuration.md does not mention {missing:?}"
    );
}

#[test]
fn command_reference_names_every_subcommand() {
    let docs = read("docs/src/cli.md");
    let mut paths = Vec::new();
    command_paths(&Cli::command(), "", &mut paths);
    assert!(paths.iter().any(|path| path == "db migrate"));
    let missing = paths
        .into_iter()
        .filter(|path| !docs.contains(&format!("oneloop {path}")))
        .collect::<Vec<_>>();
    assert!(
        missing.is_empty(),
        "docs/src/cli.md does not mention {missing:?}"
    );
}

#[test]
fn quick_start_compose_file_matches_the_deploy_example() {
    let docs = read("docs/src/quick-start.md");
    let block = docs
        .split_once("```yaml\n")
        .and_then(|(_, rest)| rest.split_once("```\n"))
        .expect("quick-start.md has a yaml block")
        .0;
    assert_eq!(
        block,
        read("deploy/compose.yaml"),
        "the compose.yaml in docs/src/quick-start.md differs from deploy/compose.yaml"
    );
}

#[tokio::test]
async fn mcp_reference_lists_every_tool_and_operation() {
    let (_dir, _db, app, session, _user) = fixture().await;
    let client = register(&app).await;
    let (code, verifier) = authorize(&app, &session, &client).await;
    let tokens = issue(&app, &client, &code, &verifier).await;
    let mut mcp =
        McpClient::connect(&app, tokens["access_token"].as_str().unwrap().to_owned()).await;
    let listed = mcp.request("tools/list", json!({})).await;
    let registered = listed["result"]["tools"].as_array().unwrap();
    let docs = read("docs/src/mcp-tools.md");

    let documented_access = table_rows(&docs, "# MCP tools")
        .into_iter()
        .map(|cells| (cells[0].trim_matches('`').to_owned(), cells[2].to_owned()))
        .collect::<BTreeMap<_, _>>();
    let documented_operations = table_rows(&docs, "## Operations")
        .into_iter()
        .map(|cells| {
            let operations = cells[1]
                .split(',')
                .map(|operation| operation.trim().trim_matches('`').to_owned())
                .collect::<BTreeSet<_>>();
            (cells[0].trim_matches('`').to_owned(), operations)
        })
        .collect::<BTreeMap<_, _>>();

    assert_eq!(documented_access.len(), registered.len());
    for tool in registered {
        let name = tool["name"].as_str().unwrap();
        let annotations = &tool["annotations"];
        let access = if annotations["destructiveHint"] == json!(true) {
            "Delete"
        } else if annotations["readOnlyHint"] == json!(true) {
            "Read"
        } else {
            "Write"
        };
        assert_eq!(
            documented_access.get(name).map(String::as_str),
            Some(access),
            "missing or incorrect tool reference for {name}"
        );

        let operations = tool["inputSchema"]["oneOf"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|variant| variant["properties"]["operation"]["const"].as_str())
            .map(str::to_owned)
            .collect::<BTreeSet<_>>();
        let documented = documented_operations.get(name);
        if operations.is_empty() {
            assert!(documented.is_none(), "{name} has no operations to document");
        } else {
            assert_eq!(
                documented,
                Some(&operations),
                "operations for {name} in docs/src/mcp-tools.md"
            );
        }
    }
}
