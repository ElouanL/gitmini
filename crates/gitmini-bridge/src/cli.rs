//! Command line: `gitmini-bridge [<repository path>] [--port 1430] [--static-dir dist] [--config-dir <directory>]`.
use std::net::Ipv4Addr;
use std::path::PathBuf;

pub const DEFAULT_PORT: u16 = 1430;
pub const DEFAULT_STATIC_DIR: &str = "dist";

pub const USAGE: &str = "\
gitmini-bridge: development bridge HTTP for gitmini (host gitmini-core, serves the frontend).

USAGE
gitmini-bridge [<repository path>] [OPTIONS]

OPTIONS
--port <n> listening port (default 1430; 0 = free port, displayed on startup)
--host <address> 127.0.0.1 or localhost (any other address is refused)
--static-dir <folder> built-to-serve frontend (default: dist; ignored if it does not exist)
--config-dir <folder> folder of settings.json (default: temporary folder deleted at stop)
-h, --help displays this help
-V, --version displays the version

The indicated repository is opened at the start by the frontend (app_info.initialPath).
Variables: RUST_LOG (log level), GITMINI_* of building e2e (see ).
";

#[derive(Debug, PartialEq, Eq)]
pub struct Cli {
    pub repo: Option<PathBuf>,
    pub host: Ipv4Addr,
    pub port: u16,
    pub static_dir: PathBuf,
    pub config_dir: Option<PathBuf>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Parsed {
    Run(Cli),
    Help,
    Version,
}

/// `args` does not contain the name of the program. Error: message to display (output code 2).
pub fn parse<I, S>(args: I) -> Result<Parsed, String>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut cli = Cli {
        repo: None,
        host: Ipv4Addr::LOCALHOST,
        port: DEFAULT_PORT,
        static_dir: PathBuf::from(DEFAULT_STATIC_DIR),
        config_dir: None,
    };
    let mut args = args.into_iter().map(Into::into);
    let mut only_positional = false;
    while let Some(arg) = args.next() {
        if only_positional || !arg.starts_with('-') || arg == "-" {
            set_repo(&mut cli, arg)?;
            continue;
        }
        if arg == "--" {
            only_positional = true;
            continue;
        }
        let (flag, inline) = match arg.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f.to_string(), Some(v.to_string())),
            _ => (arg, None),
        };
        match flag.as_str() {
            "-h" | "--help" => return Ok(Parsed::Help),
            "-V" | "--version" => return Ok(Parsed::Version),
            "--port" => {
                let v = value(&flag, inline, &mut args)?;
                cli.port = v
                    .parse::<u16>()
                    .map_err(|_| format!("--port: \"{v}\" is not a port (0-65535)"))?;
            }
            "--host" => {
                let v = value(&flag, inline, &mut args)?;
                cli.host = match v.as_str() {
                    "127.0.0.1" | "localhost" => Ipv4Addr::LOCALHOST,
                    _ => {
                        return Err(format!(
                            "--host: address refused \"{v}\". The bridge gives access to git and disk: \
He only listens to 127.0.0.1."
                        ));
                    }
                };
            }
            "--static-dir" => cli.static_dir = PathBuf::from(value(&flag, inline, &mut args)?),
            "--config-dir" => {
                cli.config_dir = Some(PathBuf::from(value(&flag, inline, &mut args)?))
            }
            _ => return Err(format!("unknown option: {flag}")),
        }
    }
    Ok(Parsed::Run(cli))
}

fn set_repo(cli: &mut Cli, arg: String) -> Result<(), String> {
    if let Some(prev) = &cli.repo {
        return Err(format!(
            "one repository expected (received \"{}\" and then \"{arg}\")",
            prev.display()
        ));
    }
    cli.repo = Some(PathBuf::from(arg));
    Ok(())
}

fn value(
    flag: &str,
    inline: Option<String>,
    rest: &mut impl Iterator<Item = String>,
) -> Result<String, String> {
    match inline {
        Some(v) => Ok(v),
        None => rest.next().ok_or_else(|| format!("{flag} expects a value")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(args: &[&str]) -> Cli {
        match parse(args.iter().copied()).unwrap() {
            Parsed::Run(c) => c,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn defaults() {
        let c = run(&[]);
        assert_eq!(c.repo, None);
        assert_eq!(c.host, Ipv4Addr::LOCALHOST);
        assert_eq!(c.port, 1430);
        assert_eq!(c.static_dir, PathBuf::from("dist"));
        assert_eq!(c.config_dir, None);
    }

    #[test]
    fn full_command_line() {
        let c = run(&[
            "/tmp/repo",
            "--port",
            "0",
            "--static-dir=build",
            "--config-dir",
            "/tmp/cfg",
            "--host",
            "localhost",
        ]);
        assert_eq!(c.repo, Some(PathBuf::from("/tmp/repo")));
        assert_eq!(c.port, 0);
        assert_eq!(c.static_dir, PathBuf::from("build"));
        assert_eq!(c.config_dir, Some(PathBuf::from("/tmp/cfg")));
    }

    #[test]
    fn repo_may_come_after_options_or_after_double_dash() {
        assert_eq!(
            run(&["--port=1500", "repo"]).repo,
            Some(PathBuf::from("repo"))
        );
        assert_eq!(run(&["--", "-weird"]).repo, Some(PathBuf::from("-weird")));
    }

    #[test]
    fn refuses_non_loopback_hosts() {
        for host in ["0.0.0.0", "192.168.1.5", "::", "::1", "example.org", ""] {
            let err = parse(["--host", host]).unwrap_err();
            assert!(err.contains("refused"), "{host}: {err}");
        }
    }

    #[test]
    fn rejects_bad_input() {
        assert!(parse(["--port"]).unwrap_err().contains("expects a value"));
        assert!(parse(["--port", "70000"]).unwrap_err().contains("--port"));
        assert!(parse(["--port", "abc"]).unwrap_err().contains("--port"));
        assert!(parse(["--nope"]).unwrap_err().contains("--nope"));
        assert!(parse(["a", "b"]).unwrap_err().contains("one repository"));
    }

    #[test]
    fn help_and_version() {
        assert_eq!(parse(["--help"]).unwrap(), Parsed::Help);
        assert_eq!(parse(["x", "-h"]).unwrap(), Parsed::Help);
        assert_eq!(parse(["-V"]).unwrap(), Parsed::Version);
    }
}
