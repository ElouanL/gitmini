//! `cargo run -p gitmini-core --example gen_types [path]`: writes `src/lib/ipc/types.ts`.
fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| {
        let root =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/lib/ipc/types.ts");
        root.to_string_lossy().into_owned()
    });
    if let Some(dir) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(dir).expect("create dir");
    }
    gitmini_core::ts::export_to(&path).expect("export types");
    println!("types written in {path}");
}
