//! Membership changes preserve assignment history and require current administrator access.
use super::*;

pub(super) fn add_membership(
    tx: &Transaction<'_>,
    actor: &Actor,
    stored: &StoredActor,
    input: MembershipCreate,
    now: i64,
) -> AppResult<Mutation> {
    require_admin(actor, stored)?;
    ensure_project_and_active_user(tx, &input.project_id, &input.user_id)?;
    let membership_id = format!("{}:{}", input.project_id, input.user_id);
    // Raw membership history is permanent, including removals. Reuse its
    // revision high-water mark so a previous membership can never match again.
    let revision: i64 = tx.query_row(
        "SELECT COALESCE(MAX(entity_revision),0)+1 FROM activity_events
         WHERE entity_type='membership' AND entity_id=?1",
        [&membership_id],
        |row| row.get(0),
    )?;
    tx.execute(
        "INSERT INTO project_memberships (project_id,user_id,manage_roadmap,manage_board,\
                     created_at,updated_at,revision) VALUES (?1,?2,?3,?4,?5,?5,?6)",
        params![
            input.project_id,
            input.user_id,
            input.manage_roadmap,
            input.manage_board,
            now,
            revision
        ],
    )
    .map_err(|error| {
        if is_constraint(&error) {
            AppError::rule(
                crate::error::RuleKind::AlreadyMember,
                "user is already a project member",
            )
        } else {
            error.into()
        }
    })?;
    let entity = json!({
    "entityType":"membership",
    "projectId":input.project_id,
    "userId":input.user_id,
    "manageRoadmap":input.manage_roadmap,
    "manageBoard":input.manage_board,
    "revision":revision
    });
    let event = activity(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&input.project_id),
            entity_type: "membership",
            entity_id: &membership_id,
            task_id: None,
            event_type: "membership.added",
            field_key: None,
            before: None,
            after: Some(entity.clone()),
            metadata: json!({}),
            entity_revision: Some(revision),
        },
        now,
    )?;
    crate::collaboration::enqueue_access_change_tx(tx, &input.user_id, now)?;
    Ok(Mutation::one(entity, event, "membership", &input.user_id))
}

pub(super) fn update_membership(
    tx: &Transaction<'_>,
    actor: &Actor,
    stored: &StoredActor,
    input: MembershipUpdate,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    require_admin(actor, stored)?;
    let before: (bool, bool, i64) = tx
        .query_row(
            SELECT_PROJECT_MEMBERSHIPS_SQL,
            params![input.project_id, input.user_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?
        .ok_or_else(|| not_found("membership"))?;
    ensure_revision(before.2, expected)?;
    if before.0 == input.manage_roadmap && before.1 == input.manage_board {
        return Err(AppError::validation(
            "payload",
            "no membership fields changed",
        ));
    }
    let revision = expected + 1;
    tx.execute(
        "UPDATE project_memberships SET manage_roadmap=?1,manage_board=?2,updated_at=?3,\
                     revision=?4 WHERE project_id=?5 AND user_id=?6 AND revision=?7",
        params![
            input.manage_roadmap,
            input.manage_board,
            now,
            revision,
            input.project_id,
            input.user_id,
            expected
        ],
    )?;
    let entity = json!({
    "entityType":"membership",
    "projectId":input.project_id,
    "userId":input.user_id,
    "manageRoadmap":input.manage_roadmap,
    "manageBoard":input.manage_board,
    "revision":revision
    });
    let membership_id = format!("{}:{}", input.project_id, input.user_id);
    let event = activity(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&input.project_id),
            entity_type: "membership",
            entity_id: &membership_id,
            task_id: None,
            event_type: "membership.updated",
            field_key: None,
            before: Some(json!({"manageRoadmap":before.0,"manageBoard":before.1})),
            after: Some(
                json!({"manageRoadmap":input.manage_roadmap,"manageBoard":input.manage_board}),
            ),
            metadata: json!({}),
            entity_revision: Some(revision),
        },
        now,
    )?;
    Ok(Mutation::one(entity, event, "membership", &input.user_id))
}

pub(super) fn remove_membership(
    tx: &Transaction<'_>,
    actor: &Actor,
    stored: &StoredActor,
    input: MembershipDelete,
    expected: i64,
    now: i64,
) -> AppResult<Mutation> {
    require_admin(actor, stored)?;
    let revision: i64 = tx
        .query_row(
            "SELECT revision FROM project_memberships WHERE project_id=?1 AND user_id=?2",
            params![input.project_id, input.user_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| not_found("membership"))?;
    ensure_revision(revision, expected)?;
    let unfinished: bool = tx.query_row(
        SELECT_TASK_ASSIGNEES_SQL,
        params![input.user_id, input.project_id],
        |row| row.get(0),
    )?;
    if unfinished {
        return Err(AppError::rule(
            crate::error::RuleKind::MemberHasOpenTasks,
            "reassign the member's unfinished tasks before removal",
        ));
    }
    let membership_id = format!("{}:{}", input.project_id, input.user_id);
    let event = activity(
        tx,
        actor,
        ActivityInput {
            project_id: Some(&input.project_id),
            entity_type: "membership",
            entity_id: &membership_id,
            task_id: None,
            event_type: "membership.removed",
            field_key: None,
            before: Some(json!({"userId":input.user_id})),
            after: None,
            metadata: json!({}),
            entity_revision: Some(revision + 1),
        },
        now,
    )?;
    tx.execute(
        "DELETE FROM project_memberships WHERE project_id=?1 AND user_id=?2 AND revision=?3",
        params![input.project_id, input.user_id, expected],
    )?;
    crate::collaboration::enqueue_access_change_tx(tx, &input.user_id, now)?;
    let entity = json!({
    "entityType":"membership",
    "projectId":input.project_id,
    "userId":input.user_id,
    "deleted":true,
    "revision":revision+1
    });
    Ok(Mutation::one(entity, event, "membership", &input.user_id))
}
