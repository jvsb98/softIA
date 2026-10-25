-- =====================================================================
-- softIA · schema do cliente · 003 · Construtor de fluxos
-- =====================================================================

CREATE TABLE flows (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL,
  description          text,
  draft                jsonb NOT NULL DEFAULT '{"nodes":[],"edges":[]}'::jsonb,
  draft_updated_at     timestamptz NOT NULL DEFAULT now(),
  draft_updated_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  published_version_id uuid,
  archived             boolean NOT NULL DEFAULT false,
  created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE flow_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id      uuid NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  version      int NOT NULL,
  definition   jsonb NOT NULL,
  note         text,
  published_by uuid REFERENCES users(id) ON DELETE SET NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (flow_id, version)
);
ALTER TABLE flows ADD CONSTRAINT flows_published_fk FOREIGN KEY (published_version_id) REFERENCES flow_versions(id) ON DELETE SET NULL;

CREATE TABLE flow_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id         uuid NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  flow_version_id uuid NOT NULL REFERENCES flow_versions(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'running' CHECK (status IN ('running','waiting','done','transferred','closed','failed','cancelled')),
  current_node_id text,
  waiting_for     text CHECK (waiting_for IN ('reply','timer')),
  waiting_since   timestamptz,
  wake_token      text,
  retries         int NOT NULL DEFAULT 0,
  vars            jsonb NOT NULL DEFAULT '{}'::jsonb,
  error           text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz
);
CREATE UNIQUE INDEX flow_runs_active_uq ON flow_runs(conversation_id) WHERE status IN ('running','waiting');
CREATE INDEX flow_runs_flow_idx ON flow_runs(flow_id, started_at DESC);

CREATE TABLE flow_run_steps (
  id         bigserial PRIMARY KEY,
  run_id     uuid NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  flow_version_id uuid NOT NULL,
  node_id    text NOT NULL,
  node_type  text NOT NULL,
  handle_out text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX flow_run_steps_run_idx ON flow_run_steps(run_id, id);
CREATE INDEX flow_run_steps_version_idx ON flow_run_steps(flow_version_id, node_id);

ALTER TABLE connections ADD COLUMN entry_flow_id uuid REFERENCES flows(id) ON DELETE SET NULL;
