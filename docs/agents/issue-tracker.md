# Issue tracker: Plane

Issues and specs for this repo live as **work items** in the **`pi-extensions`** project (`PIEXTENSIO`) on Plane. Use the **Plane MCP tools** for all operations — these are available to skills running in this repo. There is no `gh` / git-remote coupling; Plane is independent of this repo's GitHub remote.

## Project & workspace

- **Project**: `pi-extensions` — identifier `PIEXTENSIO`, id `270cee3f-cf84-48c8-bd4f-0882689f2a87`.
- All new issues go into this project. Look the id up with `plane_list_projects` if it ever changes.

## State vocabulary

States in this project (reference by name; resolve the id with `plane_list_states`):

| State     | Group      | Use for                                       |
| --------- | ---------- | --------------------------------------------- |
| Backlog   | backlog    | default landing state for new issues          |
| Todo      | unstarted  | accepted, queued for work                     |
| In Progress | started  | actively being worked                         |
| Done      | completed  | finished                                      |
| Cancelled | cancelled  | discarded / wontfix-via-state                 |

A "closed" issue = `Done` or `Cancelled` (group `completed` / `cancelled`). "Open" = everything else (`plane_get_pql_reference` → `stateGroup IN openStates()`).

## Conventions

- **Create an issue**: `plane_create_work_item(project_id, name, description_html=...)`. It lands in `Backlog` by default. For triage, also attach the `needs-triage` label (create the label with `plane_create_label` on first use — none exist yet).
- **Read an issue**: `plane_retrieve_work_item(project_id, work_item_id, expand="assignees,labels,state")` — or `plane_retrieve_work_item_by_identifier("PIEXTENSIO-<n>")` when you only have the `PIEXTENSIO-N` id.
- **List issues**: `plane_list_work_items(project_id, pql=..., expand="labels,state")`. Resolve label/state names to ids first (`plane_list_labels`, `plane_list_states`). PQL examples: `stateGroup IN openStates()`; `priority = "high"`; `labels = "<label-uuid>"`. Call `plane_get_pql_reference` for full syntax.
- **Search by text**: `plane_search_work_items(query="...")` — matches name, sequence id, and project identifier (not the description body).
- **Comment on an issue**: `plane_create_work_item_comment(project_id, work_item_id, comment_html="...")`.
- **Apply / remove a label**: `plane_manage_work_item_label(project_id, work_item_id, add_label_id=..., remove_label_id=...)` — add/remove one label without replacing the list.
- **Change state**: `plane_update_work_item(project_id, work_item_id, state=<state-id>)`.
- **Close**: set state to `Done` (or `Cancelled` for wontfix).

## Pull requests as a triage surface

**PRs as a request surface: no.** PRs live on GitHub (`SikongJueluo/pi-extensions`) but are **not** treated as triage tickets. Only Plane work items go through triage. Flip this to `yes` and describe the GitHub-PR flow if you ever want external PRs in the queue.

## When a skill says "publish to the issue tracker"

Create a Plane work item via `plane_create_work_item` in the `pi-extensions` project.

## When a skill says "fetch the relevant ticket"

`plane_retrieve_work_item_by_identifier("PIEXTENSIO-<n>", expand="assignees,labels,state")`, plus `plane_list_work_item_comments` to read the discussion.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single work item with **child** work items as tickets.

- **Map**: a single work item labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. Create with `plane_create_work_item`, then `plane_create_label(project_id, "wayfinder:map", ...)` if the label doesn't exist, then attach it.
- **Child ticket**: a work item whose `parent` is the map — `plane_create_work_item(..., parent=<map-id>)` or `plane_update_work_item(parent=<map-id>)`. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, assign the driving dev via `plane_manage_work_item_assignee`.
- **Blocking**: native work-item relations are gated on this workspace's plan, so use a **body-text fallback** — put `Blocked by: PIEXTENSIO-<n>, PIEXTENSIO-<n>` at the top of the child body. A ticket is unblocked when every blocker is `Done`/`Cancelled`.
- **Frontier query**: list the map's open children via `plane_list_work_items` filtered to the map's children and `stateGroup IN openStates()`; drop any with an open `Blocked by` line or an assignee; first in created order wins.
- **Claim**: `plane_manage_work_item_assignee(project_id, work_item_id, add_user_id=<me>)` — resolve `<me>` with `plane_get_me`. The session's first write.
- **Resolve**: `plane_create_work_item_comment` with the answer, then `plane_update_work_item(state=<Done-id>)`, then append a context pointer (gist + link) to the map's Decisions-so-far (edit the map's description via `plane_update_work_item`).
