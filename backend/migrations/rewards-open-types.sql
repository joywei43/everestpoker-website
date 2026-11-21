-- Removes the fixed list of reward types from the table (the API checks the type), so adding a type never needs a table change.
-- Run by deploy-api.yml only while the live table still has a CHECK on type; the copy keeps every reward.
DROP TABLE IF EXISTS rewards_v2;
CREATE TABLE rewards_v2(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 member_id INTEGER NOT NULL REFERENCES members(id),
 group_id TEXT,
 type TEXT NOT NULL, -- checked by the API (REWARD_TYPES in members.mjs)
 detail TEXT NOT NULL DEFAULT '',
 amount INTEGER NOT NULL CHECK(amount>=0),
 given_at INTEGER NOT NULL,
 recorded_by TEXT NOT NULL,
 approved_by TEXT NOT NULL DEFAULT '',
 approved_at INTEGER, -- NULL = waiting for a manager; only approved rewards count in cost totals
 voided INTEGER NOT NULL DEFAULT 0,
 void_reason TEXT NOT NULL DEFAULT '',
 created_at INTEGER NOT NULL
);
INSERT INTO rewards_v2(id,member_id,group_id,type,detail,amount,given_at,recorded_by,approved_by,approved_at,voided,void_reason,created_at) SELECT id,member_id,group_id,type,detail,amount,given_at,recorded_by,approved_by,approved_at,voided,void_reason,created_at FROM rewards;
DROP TABLE rewards;
ALTER TABLE rewards_v2 RENAME TO rewards;
CREATE INDEX IF NOT EXISTS rewards_member ON rewards(member_id,given_at);
CREATE INDEX IF NOT EXISTS rewards_group ON rewards(group_id,given_at);
