SELECT 'entries_live' t, count(*) n FROM cage_docs WHERE coll='entries' AND deleted=0 AND updated>=1795301700;
SELECT 'entries_deleted' t, count(*) n FROM cage_docs WHERE updated_by='cleanup (test data)';
SELECT 'ppm_t1' t, version, json_extract(data,'$[0].isRunning') running, json_array_length(json_extract(data,'$[0].sessions')) sessions, (SELECT count(*) FROM json_each(json_extract(data,'$[0].seats')) WHERE json_extract(value,'$.status')<>'idle') busy FROM ppm WHERE id=1;
SELECT 'room' t, json_extract(data,'$.occupied[0]') occ, json_extract(data,'$.tableOpen') open FROM room WHERE id=1;
SELECT 'left' t, (SELECT count(*) FROM play_sessions WHERE created_at>=1795301700000) ps, (SELECT count(*) FROM ppm_waiting) w, (SELECT count(*) FROM ppm_events WHERE at>=1795301700) ev, (SELECT count(*) FROM table_runs WHERE opened_at>=1795301700) tr, (SELECT count(*) FROM rewards WHERE created_at>=1795301700) rewards_kept;
