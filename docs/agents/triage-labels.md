# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker (Plane, project `pi-extensions` / `PIEXTENSIO`).

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

## Plane notes

- These labels **do not exist yet** in the `pi-extensions` project. The `triage` skill should create each label with `plane_create_label(project_id, name=...)` on first use (Plane has no predefined triage labels), then attach it with `plane_manage_work_item_label`. Resolve label names to ids via `plane_list_labels`.
- `wontfix` can be expressed either as a label **or** by moving the work item to the `Cancelled` state — prefer the label for explicit triage intent, and state for final closure.
- Edit the right-hand column to match any other vocabulary you adopt later.
