//! Integration tests for oneloop, built as one crate so Cargo compiles and
//! links a single test binary. Each module covers one area of the product;
//! `support` holds the only helpers shared between areas.
//!
//! Run one area with `cargo test --locked --test integration files::`.

mod support;

mod auth;
mod authz;
mod build_script;
mod cli;
mod collaboration;
mod config;
mod db;
mod docs;
mod domain;
mod errors;
mod files;
mod http;
mod knowledge;
mod mcp;
mod runtime;
