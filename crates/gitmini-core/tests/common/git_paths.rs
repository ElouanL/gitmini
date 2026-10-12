//! Convert Rust's verbatim Windows paths at the Git CLI boundary.
#![allow(dead_code)]

pub fn argument(arg: &str) -> String {
    #[cfg(windows)]
    {
        if let Some(path) = arg.strip_prefix("file://")
            && path.starts_with(r"\\?\")
        {
            let path = argument(path);
            return url::Url::from_file_path(path).unwrap().into();
        }
        if let Some(path) = arg.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{path}");
        }
        if let Some(path) = arg.strip_prefix(r"\\?\") {
            return path.into();
        }
    }
    arg.into()
}
