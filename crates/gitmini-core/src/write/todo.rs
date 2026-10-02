//! Pure generation of the interactive rebase todo.
//!
//! No input/output here: [`validate`] applies rules 07 (`all-dropped`, `first-is-squash`,
//! `empty-message`) and [`build`] translates `TodoItem[]` into todo text plus message files.
//! Message files are written with `/` and escaped for `sh` (git runs `exec` by its shell).
use std::path::Path;

use crate::types::{TodoAction, TodoItem};
use crate::write::runner::sh_quote;

/// Validation rule violated (`INVALID_ARGUMENT { field: "todo", reason }`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TodoInvalid {
    /// It's all `drop`.
    AllDropped,
    /// The first non-`drop` line is a `squash` or a `fixup` line.
    FirstIsSquash,
    /// A `reword` without message (empty or white).
    EmptyMessage,
}

impl TodoInvalid {
    pub fn reason(self) -> &'static str {
        match self {
            TodoInvalid::AllDropped => "all-dropped",
            TodoInvalid::FirstIsSquash => "first-is-squash",
            TodoInvalid::EmptyMessage => "empty-message",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            TodoInvalid::AllDropped => "All commits are deleted: there is nothing left to play.",
            TodoInvalid::FirstIsSquash => {
                "The first commit cannot be merged with a previous commit."
            }
            TodoInvalid::EmptyMessage => "A reformulated commit must have an empty message.",
        }
    }
}

/// Check the list in order `all-dropped`, `first-is-squash`, `empty-message`.
pub fn validate(items: &[TodoItem]) -> Result<(), TodoInvalid> {
    let mut kept = items.iter().filter(|i| i.action != TodoAction::Drop);
    let Some(first) = kept.next() else {
        return Err(TodoInvalid::AllDropped);
    };
    if is_member(first.action) {
        return Err(TodoInvalid::FirstIsSquash);
    }
    if items
        .iter()
        .any(|i| i.action == TodoAction::Reword && is_blank(i.message.as_deref()))
    {
        return Err(TodoInvalid::EmptyMessage);
    }
    Ok(())
}

/// A message file to write in the temporary folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageFile {
    /// File name (`msg-1`, `msg-2`...), numbered in order of appearance of `exec`.
    pub name: String,
    pub content: String,
}

/// Translation result: contents of `todo` file and `msg-<n>` files.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TodoPlan {
    pub todo: String,
    pub messages: Vec<MessageFile>,
}

fn is_member(a: TodoAction) -> bool {
    matches!(a, TodoAction::Squash | TodoAction::Fixup)
}

fn is_blank(m: Option<&str>) -> bool {
    m.is_none_or(|s| s.trim().is_empty())
}

/// Group: a `pick`/`reword` followed by its `squash`/`fixup` (the interlayered `drop` are ignored).
struct Group {
    head: usize,
    members: Vec<usize>,
}

impl Group {
    /// Group final message: the DERNIER member, absent if empty.
    fn final_message<'a>(&self, items: &'a [TodoItem]) -> Option<&'a str> {
        let last = *self.members.last()?;
        items[last]
            .message
            .as_deref()
            .filter(|m| !m.trim().is_empty())
    }
}

/// Translates the list into todo (one line per item, complete oids, selected order) according to the table of
///
/// `dir` is the temporary folder `$TMP/gitmini-<opId>/`: it is not affected, only cited in the `exec`.
/// The list must have passed [`validate`]; a list starting with a `squash` is tolerated (the first item
/// no `drop` is then treated as a `pick`).
pub fn build(items: &[TodoItem], dir: &Path) -> TodoPlan {
    let mut groups: Vec<Group> = Vec::new();
    // Group index of each item (None for drop).
    let mut group_of: Vec<Option<usize>> = vec![None; items.len()];
    for (idx, item) in items.iter().enumerate() {
        match item.action {
            TodoAction::Drop => {}
            TodoAction::Pick | TodoAction::Reword => {
                groups.push(Group {
                    head: idx,
                    members: Vec::new(),
                });
                group_of[idx] = Some(groups.len() - 1);
            }
            TodoAction::Squash | TodoAction::Fixup => match groups.last_mut() {
                Some(g) => {
                    g.members.push(idx);
                    group_of[idx] = Some(groups.len() - 1);
                }
                None => {
                    groups.push(Group {
                        head: idx,
                        members: Vec::new(),
                    });
                    group_of[idx] = Some(groups.len() - 1);
                }
            },
        }
    }

    let dir = dir.to_string_lossy().replace('\\', "/");
    let dir = dir.trim_end_matches('/');
    let mut todo = String::new();
    let mut messages: Vec<MessageFile> = Vec::new();
    let mut exec_for = |content: &str, todo: &mut String| {
        let name = format!("msg-{}", messages.len() + 1);
        todo.push_str(&format!(
            "exec git commit --amend --only --cleanup=whitespace -F {}\n",
            sh_quote(&format!("{dir}/{name}"))
        ));
        messages.push(MessageFile {
            name,
            content: content.to_string(),
        });
    };

    for (idx, item) in items.iter().enumerate() {
        let oid = &item.oid;
        let Some(gi) = group_of[idx] else {
            todo.push_str(&format!("drop {oid}\n"));
            continue;
        };
        let group = &groups[gi];
        let final_message = group.final_message(items);
        if group.head == idx {
            todo.push_str(&format!("pick {oid}\n"));
            // A final group message replaces the top word: one `exec`, after the last member.
            if item.action == TodoAction::Reword
                && final_message.is_none()
                && let Some(m) = item.message.as_deref()
            {
                exec_for(m, &mut todo);
            }
        } else {
            let verb = match (final_message.is_some(), item.action) {
                (true, _) => "fixup",
                (false, TodoAction::Squash) => "squash",
                (false, _) => "fixup",
            };
            todo.push_str(&format!("{verb} {oid}\n"));
            if let Some(m) = final_message
                && group.members.last() == Some(&idx)
            {
                exec_for(m, &mut todo);
            }
        }
    }
    TodoPlan { todo, messages }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn oid(n: u8) -> String {
        format!("{n:040x}")
    }

    fn item(n: u8, action: TodoAction, message: Option<&str>) -> TodoItem {
        TodoItem {
            oid: oid(n),
            action,
            message: message.map(str::to_string),
        }
    }

    fn dir() -> PathBuf {
        PathBuf::from("/tmp/gitmini-op-1")
    }

    fn render(items: &[TodoItem]) -> String {
        let plan = build(items, &dir());
        let mut out = plan.todo.clone();
        for m in &plan.messages {
            out.push_str(&format!("--- {} ---\n{}\n", m.name, m.content));
        }
        out.replace(&oid(1), "<1>")
            .replace(&oid(2), "<2>")
            .replace(&oid(3), "<3>")
            .replace(&oid(4), "<4>")
            .replace(&oid(5), "<5>")
    }

    #[test]
    fn pick_and_drop_are_plain_lines() {
        let s = render(&[
            item(1, TodoAction::Pick, None),
            item(2, TodoAction::Drop, None),
            item(3, TodoAction::Pick, None),
        ]);
        insta::assert_snapshot!(s, @r"
        pick <1>
        drop <2>
        pick <3>
        ");
    }

    #[test]
    fn reword_is_pick_plus_amend_exec() {
        let s = render(&[
            item(1, TodoAction::Pick, None),
            item(2, TodoAction::Reword, Some("C: renamed\n\nbody")),
        ]);
        insta::assert_snapshot!(s, @r"
        pick <1>
        pick <2>
        exec git commit --amend --only --cleanup=whitespace -F '/tmp/gitmini-op-1/msg-1'
        --- msg-1 ---
        C: renamed

        body
        ");
    }

    #[test]
    fn group_with_final_message_uses_fixup_and_one_exec_after_last_member() {
        // IRB-01 : A, fixup!, B (squash, porter le message), D, reword C.
        let s = render(&[
            item(1, TodoAction::Pick, None),
            item(2, TodoAction::Fixup, None),
            item(
                3,
                TodoAction::Squash,
                Some("A: adds a.txt\n\nIncludes correction B."),
            ),
            item(4, TodoAction::Pick, None),
            item(5, TodoAction::Reword, Some("C: adds c.txt (renamed)")),
        ]);
        insta::assert_snapshot!(s, @r"
        pick <1>
        fixup <2>
        fixup <3>
        exec git commit --amend --only --cleanup=whitespace -F '/tmp/gitmini-op-1/msg-1'
        pick <4>
        pick <5>
        exec git commit --amend --only --cleanup=whitespace -F '/tmp/gitmini-op-1/msg-2'
        --- msg-1 ---
        A: adds a.txt

        Includes correction B.
        --- msg-2 ---
        C: adds c.txt (renamed)
        ");
    }

    #[test]
    fn group_without_final_message_keeps_squash_and_fixup() {
        let s = render(&[
            item(1, TodoAction::Pick, None),
            item(2, TodoAction::Squash, None),
            item(3, TodoAction::Fixup, None),
            item(4, TodoAction::Pick, None),
        ]);
        insta::assert_snapshot!(s, @r"
        pick <1>
        squash <2>
        fixup <3>
        pick <4>
        ");
    }

    #[test]
    fn blank_group_message_counts_as_absent() {
        let s = render(&[
            item(1, TodoAction::Pick, None),
            item(2, TodoAction::Squash, Some("  \n")),
        ]);
        insta::assert_snapshot!(s, @r"
        pick <1>
        squash <2>
        ");
    }

    #[test]
    fn message_of_a_non_last_member_is_ignored() {
        let s = render(&[
            item(1, TodoAction::Pick, None),
            item(2, TodoAction::Squash, Some("ignored")),
            item(3, TodoAction::Fixup, None),
        ]);
        insta::assert_snapshot!(s, @r"
        pick <1>
        squash <2>
        fixup <3>
        ");
    }

    #[test]
    fn group_message_replaces_head_reword_message() {
        let s = render(&[
            item(1, TodoAction::Reword, Some("head")),
            item(2, TodoAction::Squash, Some("final")),
        ]);
        insta::assert_snapshot!(s, @r"
        pick <1>
        fixup <2>
        exec git commit --amend --only --cleanup=whitespace -F '/tmp/gitmini-op-1/msg-1'
        --- msg-1 ---
        final
        ");
    }

    #[test]
    fn head_reword_without_group_message_keeps_its_exec_before_squash() {
        let s = render(&[
            item(1, TodoAction::Reword, Some("head")),
            item(2, TodoAction::Squash, None),
        ]);
        insta::assert_snapshot!(s, @r"
        pick <1>
        exec git commit --amend --only --cleanup=whitespace -F '/tmp/gitmini-op-1/msg-1'
        squash <2>
        --- msg-1 ---
        head
        ");
    }

    #[test]
    fn dropped_items_between_members_do_not_split_the_group() {
        let s = render(&[
            item(1, TodoAction::Pick, None),
            item(2, TodoAction::Drop, None),
            item(3, TodoAction::Squash, Some("fin")),
            item(4, TodoAction::Drop, None),
        ]);
        insta::assert_snapshot!(s, @r"
        pick <1>
        drop <2>
        fixup <3>
        exec git commit --amend --only --cleanup=whitespace -F '/tmp/gitmini-op-1/msg-1'
        drop <4>
        --- msg-1 ---
        fin
        ");
    }

    #[test]
    fn paths_use_slashes_and_are_shell_quoted() {
        let items = [item(1, TodoAction::Reword, Some("m"))];
        let plan = build(&items, Path::new("C:\\Users\\it's me\\gitmini-1"));
        assert!(
            plan.todo
                .contains(r"-F 'C:/Users/it'\''s me/gitmini-1/msg-1'"),
            "{}",
            plan.todo
        );
    }

    #[test]
    fn validation_rules() {
        assert_eq!(validate(&[]), Err(TodoInvalid::AllDropped));
        assert_eq!(
            validate(&[
                item(1, TodoAction::Drop, None),
                item(2, TodoAction::Drop, None)
            ]),
            Err(TodoInvalid::AllDropped)
        );
        assert_eq!(
            validate(&[
                item(1, TodoAction::Squash, None),
                item(2, TodoAction::Pick, None)
            ]),
            Err(TodoInvalid::FirstIsSquash)
        );
        assert_eq!(
            validate(&[
                item(1, TodoAction::Drop, None),
                item(2, TodoAction::Fixup, None)
            ]),
            Err(TodoInvalid::FirstIsSquash)
        );
        assert_eq!(
            validate(&[
                item(1, TodoAction::Pick, None),
                item(2, TodoAction::Reword, None)
            ]),
            Err(TodoInvalid::EmptyMessage)
        );
        assert_eq!(
            validate(&[item(1, TodoAction::Reword, Some("  \n"))]),
            Err(TodoInvalid::EmptyMessage)
        );
        assert_eq!(
            validate(&[
                item(1, TodoAction::Drop, None),
                item(2, TodoAction::Pick, None)
            ]),
            Ok(())
        );
        assert_eq!(TodoInvalid::AllDropped.reason(), "all-dropped");
        assert_eq!(TodoInvalid::FirstIsSquash.reason(), "first-is-squash");
        assert_eq!(TodoInvalid::EmptyMessage.reason(), "empty-message");
    }
}
