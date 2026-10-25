-- =====================================================================
-- softIA · schema plataforma · 001 · Clientes, domínios, fila e leases
-- Roda com search_path = plataforma, <schemas das extensões>, public
-- =====================================================================

-- ------------------------------------------------------------ clientes
CREATE TABLE tenants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
  name         text NOT NULL,
  schema_name  text NOT NULL UNIQUE CHECK (schema_name ~ '^t_[a-z0-9_]{1,40}$'),
  status       text NOT NULL DEFAULT 'implantacao' CHECK (status IN ('implantacao','ativo','suspenso','cancelado')),
  segment      text,
  plan         text,
  limits       jsonb NOT NULL DEFAULT '{}'::jsonb,
  brand        jsonb NOT NULL DEFAULT '{}'::jsonb,
  db_cluster   text NOT NULL DEFAULT 'principal',
  contact      jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------ hostnames de cada cliente
CREATE TABLE domains (
  hostname    text PRIMARY KEY CHECK (hostname = lower(hostname)),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'subdominio' CHECK (kind IN ('subdominio','proprio')),
  is_primary  boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX domains_tenant_idx ON domains(tenant_id);

-- ------------------------------------------------------------ fila de tarefas (todos os clientes)
CREATE TABLE jobs (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid REFERENCES tenants(id) ON DELETE CASCADE,
  queue         text        NOT NULL,
  payload       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  run_at        timestamptz NOT NULL DEFAULT now(),
  status        text        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  attempts      int         NOT NULL DEFAULT 0,
  max_attempts  int         NOT NULL DEFAULT 5,
  singleton_key text,
  group_key     text,
  locked_at     timestamptz,
  locked_by     text,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
-- singleton e grupo valem por cliente: dois clientes podem ter a mesma chave
CREATE UNIQUE INDEX jobs_singleton_uq ON jobs(queue, coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), singleton_key)
  WHERE status = 'queued' AND singleton_key IS NOT NULL;
CREATE INDEX jobs_ready_idx   ON jobs(queue, run_at) WHERE status = 'queued';
CREATE INDEX jobs_running_idx ON jobs(tenant_id, group_key) WHERE status = 'running';

-- ------------------------------------------------------------ qual processo segura cada número de WhatsApp
CREATE TABLE wa_leases (
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id  uuid NOT NULL,
  holder         text NOT NULL,
  expires_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connection_id)
);
