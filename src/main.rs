use std::io::Write;

use clap::{CommandFactory, Parser};

#[tokio::main]
async fn main() {
    // Output that nobody reads is not an error, as for every command's output;
    // a failing command keeps its exit code even when nothing reads its error.
    if std::env::args_os().len() == 1 {
        let mut command = oneloop::cli::Cli::command();
        let _ = command.print_help();
        let _ = writeln!(std::io::stdout());
        return;
    }
    let cli = oneloop::cli::Cli::parse();
    if let Err(error) = oneloop::cli::run(cli).await {
        let _ = writeln!(std::io::stderr(), "error: {error}");
        std::process::exit(error.exit_code());
    }
}
