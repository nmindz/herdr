//! DeepSeek Harness user patch layer editing.
//!
//! DSH composes a profile from bundle patch layers, then the profile's own
//! `cordis.patch.yml`, then the home-level `$DSH_HOME/cordis.patch.yml`. The
//! home layer applies to every profile and anchors relative plugin names
//! beside itself, so one herdr-owned block there loads the integration plugin
//! from `$DSH_HOME` without a package manager, a `node_modules` entry, or an
//! edit to any profile's bundle list.

const BLOCK_BEGIN: &str = "# >>> herdr dsh integration";
const BLOCK_END: &str = "# <<< herdr dsh integration";

/// The herdr-owned patch entry, as it is written to and matched in the file.
pub(crate) fn plugin_block(entry_id: &str, spec: &str) -> String {
    format!(
        "{BLOCK_BEGIN}\n- insert:\n    - id: {}\n      name: {}\n{BLOCK_END}\n",
        yaml_single_quoted(entry_id),
        yaml_single_quoted(spec)
    )
}

/// Whether the file already carries exactly this herdr-owned entry.
pub(crate) fn plugin_is_configured(content: &str, entry_id: &str, spec: &str) -> bool {
    content.contains(&plugin_block(entry_id, spec))
}

/// The file with the herdr-owned block replaced by a current one. An empty
/// flow sequence (`[]`) is dropped: it is how DSH spells "no entries" and it
/// cannot coexist with block sequence items in the same document.
pub(crate) fn build_patch_with_plugin(content: &str, entry_id: &str, spec: &str) -> String {
    let mut result = lines_without_block(content);
    if !has_sequence_entry(&result) {
        result.retain(|line| line.trim() != "[]");
    }
    let mut text = join_trimmed(&result);
    if !text.is_empty() {
        text.push('\n');
    }
    text.push_str(&plugin_block(entry_id, spec));
    text
}

/// The file with the herdr-owned block removed, or `None` when it carried no
/// block. `[]` is restored when nothing else remains, because DSH fails loud
/// on a patch file that is present but is not a YAML array.
pub(crate) fn build_patch_without_plugin(content: &str) -> Option<String> {
    if !content.contains(BLOCK_BEGIN) {
        return None;
    }

    let result = lines_without_block(content);
    let mut text = join_trimmed(&result);
    if !has_sequence_entry(&result) && !result.iter().any(|line| line.trim() == "[]") {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str("[]");
    }
    text.push('\n');
    Some(text)
}

/// Whether removing the herdr-owned block leaves the file with nothing to say.
pub(crate) fn patch_is_only_herdr_block(content: &str) -> bool {
    content.contains(BLOCK_BEGIN)
        && lines_without_block(content)
            .iter()
            .all(|line| line.trim().is_empty())
}

fn lines_without_block(content: &str) -> Vec<&str> {
    let mut lines = Vec::new();
    let mut in_block = false;
    for line in content.lines() {
        if line.trim() == BLOCK_BEGIN {
            in_block = true;
            continue;
        }
        if in_block {
            if line.trim() == BLOCK_END {
                in_block = false;
            }
            continue;
        }
        lines.push(line);
    }
    lines
}

/// Top-level block sequence items are the only rows a patch list can hold, so
/// their absence means the document has no entries.
fn has_sequence_entry(lines: &[&str]) -> bool {
    lines
        .iter()
        .any(|line| line == &"-" || line.starts_with("- "))
}

fn join_trimmed(lines: &[&str]) -> String {
    lines.join("\n").trim_end().to_string()
}

fn yaml_single_quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENTRY_ID: &str = "herdr-agent-state";
    const SPEC: &str = "./herdr-agent-state.mjs";

    #[test]
    fn installs_into_an_empty_flow_sequence_without_breaking_yaml() {
        let content = "# dsh home layer\n[]\n";
        let installed = build_patch_with_plugin(content, ENTRY_ID, SPEC);

        assert_eq!(
            installed,
            "# dsh home layer\n# >>> herdr dsh integration\n- insert:\n    - id: 'herdr-agent-state'\n      name: './herdr-agent-state.mjs'\n# <<< herdr dsh integration\n"
        );
        assert!(plugin_is_configured(&installed, ENTRY_ID, SPEC));
    }

    #[test]
    fn install_preserves_foreign_entries_and_is_idempotent() {
        let content = "- insert:\n    - id: mcp-other\n      name: 'other'\n";
        let once = build_patch_with_plugin(content, ENTRY_ID, SPEC);
        let twice = build_patch_with_plugin(&once, ENTRY_ID, SPEC);

        assert_eq!(once, twice);
        assert!(once.contains("id: mcp-other"));
        assert_eq!(once.matches(BLOCK_BEGIN).count(), 1);
    }

    #[test]
    fn reinstall_replaces_a_stale_spec() {
        let stale = build_patch_with_plugin("[]\n", ENTRY_ID, "./old.mjs");
        assert!(!plugin_is_configured(&stale, ENTRY_ID, SPEC));

        let fresh = build_patch_with_plugin(&stale, ENTRY_ID, SPEC);
        assert!(plugin_is_configured(&fresh, ENTRY_ID, SPEC));
        assert!(!fresh.contains("./old.mjs"));
    }

    #[test]
    fn uninstall_restores_an_empty_array_so_dsh_still_parses_the_file() {
        let content = build_patch_with_plugin("# keep me\n[]\n", ENTRY_ID, SPEC);
        let removed = build_patch_without_plugin(&content).unwrap();

        assert_eq!(removed, "# keep me\n[]\n");
    }

    #[test]
    fn uninstall_keeps_foreign_entries_and_adds_no_empty_array() {
        let content = build_patch_with_plugin(
            "- insert:\n    - id: mcp-other\n      name: 'other'\n",
            ENTRY_ID,
            SPEC,
        );
        let removed = build_patch_without_plugin(&content).unwrap();

        assert_eq!(
            removed,
            "- insert:\n    - id: mcp-other\n      name: 'other'\n"
        );
    }

    #[test]
    fn uninstall_reports_no_change_without_a_herdr_block() {
        assert!(build_patch_without_plugin("[]\n").is_none());
    }

    #[test]
    fn a_file_holding_only_the_herdr_block_is_removable() {
        let owned = build_patch_with_plugin("", ENTRY_ID, SPEC);
        assert!(patch_is_only_herdr_block(&owned));

        let shared = build_patch_with_plugin("# keep me\n[]\n", ENTRY_ID, SPEC);
        assert!(!patch_is_only_herdr_block(&shared));
    }
}
