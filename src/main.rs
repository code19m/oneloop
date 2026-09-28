use clap::{CommandFactory, Parser};

#[tokio::main]
async fn main() {
    if std::env::args_os().len() == 1 {
        let mut command = oneloop::cli::Cli::command();
        let _ = command.print_help();
        println!();
        return;
    }
    let cli = oneloop::cli::Cli::parse();
    if let Err(error) = oneloop::cli::run(cli).await {
        eprintln!("error: {error}");
        std::process::exit(error.exit_code());
    }
}
