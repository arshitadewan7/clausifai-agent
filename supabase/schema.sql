create table if not exists email_threads (
  id text primary key,
  sender text not null,
  subject text not null,
  snippet text not null,
  received_at timestamptz not null,
  triage_summary text not null,
  requested_action text not null,
  urgency text not null,
  needs_reply boolean not null default false,
  proposed_next_step text not null,
  created_at timestamptz not null default now()
);

create table if not exists draft_replies (
  id uuid primary key,
  thread_id text references email_threads(id) on delete cascade,
  body text not null,
  status text not null,
  approved_by text,
  sent_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists meeting_summaries (
  id uuid primary key,
  meeting_id text not null,
  title text not null,
  summary text not null,
  decisions jsonb not null default '[]'::jsonb,
  open_questions jsonb not null default '[]'::jsonb,
  drive_url text not null,
  participants jsonb not null default '[]'::jsonb,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists action_items (
  id uuid primary key default gen_random_uuid(),
  summary_id uuid references meeting_summaries(id) on delete cascade,
  owner text not null,
  task text not null,
  status text not null default 'open',
  created_at timestamptz not null default now()
);

create table if not exists integration_state (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
