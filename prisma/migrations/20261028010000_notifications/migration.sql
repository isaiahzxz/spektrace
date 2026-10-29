CREATE TABLE notification_preferences (
 workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE RESTRICT,
 preferences jsonb NOT NULL, enabled_since timestamptz NOT NULL DEFAULT now(),
 digest_cursor timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notification_groups (
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
 group_key text NOT NULL, summary jsonb NOT NULL,
 notified_calls integer NOT NULL DEFAULT 0, notified_failed integer NOT NULL DEFAULT 0,
 evaluated_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,group_key)
);
CREATE TABLE notification_members (
 workspace_id uuid NOT NULL, group_key text NOT NULL, observation_id uuid NOT NULL,
 PRIMARY KEY(workspace_id,observation_id),
 FOREIGN KEY(workspace_id,group_key) REFERENCES notification_groups(workspace_id,group_key) ON DELETE RESTRICT,
 FOREIGN KEY(workspace_id,observation_id) REFERENCES integration_observations(workspace_id,id) ON DELETE RESTRICT
);
CREATE INDEX notification_members_group_idx ON notification_members(workspace_id,group_key);
CREATE TABLE notification_deliveries (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
 dedupe_key text NOT NULL, destination text NOT NULL, payload jsonb NOT NULL,
 state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','SENDING','SENT','FAILED','CANCELLED')),
 attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
 sent_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,dedupe_key)
);
CREATE INDEX notification_delivery_pending_idx ON notification_deliveries(state,available_at);
