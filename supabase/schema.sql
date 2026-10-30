-- Crossfog: shared games for up to four players.
-- Paste into the Supabase SQL editor and run once.
-- Requires: Authentication > Sign In / Providers > "Allow anonymous sign-ins" turned on.
--
-- Model: the server stores an append-only event log per game. Clients replay
-- the log to derive the board, so there is no shared mutable state to clobber.

create table if not exists public.games (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  board_id text not null,
  created_by uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.players (
  game_id uuid not null references public.games (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 24),
  seat smallint not null check (seat between 0 and 3),
  avatar text check (avatar is null or char_length(avatar) <= 8),
  joined_at timestamptz not null default now(),
  primary key (game_id, user_id),
  unique (game_id, seat)
);

create table if not exists public.events (
  id bigint generated always as identity primary key,
  game_id uuid not null references public.games (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  client_id uuid not null unique,
  kind text not null check (kind in ('fill', 'erase', 'group', 'buy')),
  payload jsonb not null default '{}'::jsonb check (pg_column_size(payload) < 2048),
  created_at timestamptz not null default now()
);
create index if not exists events_game_id_id on public.events (game_id, id);

alter table public.games enable row level security;
alter table public.players enable row level security;
alter table public.events enable row level security;

-- Membership check used by the policies. Security definer so it can read
-- players without recursing through the players policy.
create or replace function public.is_player(g uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.players p
    where p.game_id = g and p.user_id = (select auth.uid())
  );
$$;

drop policy if exists games_select on public.games;
create policy games_select on public.games
  for select to authenticated
  using (public.is_player(id));

drop policy if exists players_select on public.players;
create policy players_select on public.players
  for select to authenticated
  using (public.is_player(game_id));

drop policy if exists players_update_own on public.players;
create policy players_update_own on public.players
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists events_select on public.events;
create policy events_select on public.events
  for select to authenticated
  using (public.is_player(game_id));

drop policy if exists events_insert on public.events;
create policy events_insert on public.events
  for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_player(game_id));

-- Games and seats are only created through these two functions, so a seat
-- can't be double-booked and a game code can't be guessed into.

create or replace function public.create_game(p_board text, p_name text)
returns public.games
language plpgsql
security definer
set search_path = ''
as $$
declare
  g public.games;
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  c text;
  tries int := 0;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if char_length(btrim(coalesce(p_name, ''))) = 0 then raise exception 'name required'; end if;
  loop
    c := '';
    for i in 1..6 loop
      c := c || substr(alphabet, 1 + floor(random() * char_length(alphabet))::int, 1);
    end loop;
    begin
      insert into public.games (code, board_id, created_by) values (c, p_board, auth.uid()) returning * into g;
      exit;
    exception when unique_violation then
      tries := tries + 1;
      if tries > 10 then raise; end if;
    end;
  end loop;
  insert into public.players (game_id, user_id, name, seat) values (g.id, auth.uid(), left(btrim(p_name), 24), 0);
  return g;
end;
$$;

create or replace function public.join_game(p_code text, p_name text)
returns public.games
language plpgsql
security definer
set search_path = ''
as $$
declare
  g public.games;
  s smallint;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into g from public.games where code = upper(btrim(p_code));
  if not found then raise exception 'No game with that code'; end if;
  if exists (select 1 from public.players where game_id = g.id and user_id = auth.uid()) then
    if char_length(btrim(coalesce(p_name, ''))) > 0 then
      update public.players set name = left(btrim(p_name), 24) where game_id = g.id and user_id = auth.uid();
    end if;
    return g;
  end if;
  if char_length(btrim(coalesce(p_name, ''))) = 0 then raise exception 'name required'; end if;
  -- lock the game row so two people joining at once can't take the same seat
  perform 1 from public.games where id = g.id for update;
  select min(x)::smallint into s
    from generate_series(0, 3) as x
    where x not in (select seat from public.players where game_id = g.id);
  if s is null then raise exception 'This game is full'; end if;
  insert into public.players (game_id, user_id, name, seat) values (g.id, auth.uid(), left(btrim(p_name), 24), s);
  return g;
end;
$$;

revoke all on function public.create_game(text, text) from public, anon;
revoke all on function public.join_game(text, text) from public, anon;
grant execute on function public.create_game(text, text) to authenticated;
grant execute on function public.join_game(text, text) to authenticated;
revoke all on function public.is_player(uuid) from public, anon;
grant execute on function public.is_player(uuid) to authenticated;

-- Live updates for moves and roster changes.
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'events') then
    alter publication supabase_realtime add table public.events;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'players') then
    alter publication supabase_realtime add table public.players;
  end if;
end $$;
