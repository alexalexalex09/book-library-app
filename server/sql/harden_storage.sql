-- ShelfMapper storage hardening (run on existing projects)
-- Makes the shelves bucket private and limits object reads/writes to owner folder.

insert into storage.buckets (id, name, public)
values ('shelves', 'shelves', false)
on conflict (id) do update
set public = false;

drop policy if exists "Public read shelf images" on storage.objects;
drop policy if exists "Users read own shelf images" on storage.objects;
create policy "Users read own shelf images"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'shelves'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users upload own shelf images" on storage.objects;
create policy "Users upload own shelf images"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'shelves'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users update own shelf images" on storage.objects;
create policy "Users update own shelf images"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'shelves'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'shelves'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users delete own shelf images" on storage.objects;
create policy "Users delete own shelf images"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'shelves'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

notify pgrst, 'reload schema';
