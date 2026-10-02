//! Token masking GitHub in logs (: `gh[opsu]_[A-Za-z0-9]+`).
use std::borrow::Cow;
use std::io::Write;

const MASK: &[u8] = b"[token masked]";

/// Replaces all `gh[opsu]_<alnum>+` and `github_pat_<alnum|_>+` with a marker.
pub fn redact_bytes(input: &[u8]) -> Cow<'_, [u8]> {
    let mut out: Option<Vec<u8>> = None;
    let mut i = 0;
    let mut copied = 0;
    while i < input.len() {
        if let Some(end) = token_end(&input[i..]) {
            let buf = out.get_or_insert_with(|| Vec::with_capacity(input.len()));
            buf.extend_from_slice(&input[copied..i]);
            buf.extend_from_slice(MASK);
            i += end;
            copied = i;
        } else {
            i += 1;
        }
    }
    match out {
        None => Cow::Borrowed(input),
        Some(mut buf) => {
            buf.extend_from_slice(&input[copied..]);
            Cow::Owned(buf)
        }
    }
}

pub fn redact(input: &str) -> Cow<'_, str> {
    match redact_bytes(input.as_bytes()) {
        Cow::Borrowed(_) => Cow::Borrowed(input),
        // Only ASCII suites are replaced by ASCII: the result remains of the valid UTF-8.
        Cow::Owned(v) => Cow::Owned(
            String::from_utf8(v)
                .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned()),
        ),
    }
}

/// Length of token that starts at the beginning of `s`, if there is one.
fn token_end(s: &[u8]) -> Option<usize> {
    let (prefix, allow_underscore) = if s.starts_with(b"github_pat_") {
        (b"github_pat_".len(), true)
    } else if s.len() > 4
        && s.starts_with(b"gh")
        && matches!(s[2], b'o' | b'p' | b's' | b'u')
        && s[3] == b'_'
    {
        (4, false)
    } else {
        return None;
    };
    let body = s[prefix..]
        .iter()
        .take_while(|b| b.is_ascii_alphanumeric() || (allow_underscore && **b == b'_'))
        .count();
    (body > 0).then_some(prefix + body)
}

/// Replaces the default panic hook: same output on stderr, but masked (the message of a panic)
/// can cite a URL of remote or a token).
pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let thread = std::thread::current();
        let name = thread.name().unwrap_or("<unnamed>");
        let text = format!("\nthread '{name}' {info}\n");
        let _ = std::io::stderr().write_all(&redact_bytes(text.as_bytes()));
    }));
}

/// `MakeWriter` `tracing-subscriber`: Each formatted event passes through [`redact_bytes`].
#[derive(Clone, Copy, Default)]
pub struct RedactingStderr;

pub struct RedactingWriter<W: Write>(W);

impl<W: Write> Write for RedactingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.write_all(&redact_bytes(buf))?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.0.flush()
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for RedactingStderr {
    type Writer = RedactingWriter<std::io::Stderr>;

    fn make_writer(&'a self) -> Self::Writer {
        RedactingWriter(std::io::stderr())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_github_tokens() {
        let t =
            "https://x-access-token:ghp_AbC123xyz@github.com/o/r.git and gho_ZZ9 then ghs_a, ghu_b";
        let r = redact(t);
        assert!(!r.contains("ghp_"), "{r}");
        assert!(!r.contains("gho_"), "{r}");
        assert!(!r.contains("ghs_"), "{r}");
        assert!(!r.contains("ghu_"), "{r}");
        assert!(r.contains("@github.com/o/r.git"), "{r}");
    }

    #[test]
    fn masks_fine_grained_tokens() {
        let r = redact("token=github_pat_11AAA_bbbCCC fin");
        assert_eq!(r, "token=[token masked] fin");
    }

    #[test]
    fn leaves_other_text_untouched() {
        for s in [
            "",
            "ghost_town",
            "gh_",
            "ghp_",
            "ghp_ x",
            "high_water",
            "summer ghp",
            "https://github.com/o/r",
        ] {
            assert!(matches!(redact(s), Cow::Borrowed(_)), "{s}");
        }
    }

    #[test]
    fn keeps_utf8_around_tokens() {
        assert_eq!(redact("é ghp_abc é"), "é [token masked] é");
    }
}
