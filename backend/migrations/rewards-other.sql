-- Adds 'other' to the reward types. Run once by deploy-api.yml when the live table does not allow 'other' yet.
DROP TABLE IF EXISTS rewards_v2;
CREATE TABLE rewards_v2(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 member_id INTEGER NOT NULL REFERENCES members(id),
 group_id TEXT,
 type TEXT NOT NULL CHECK(type IN ('free_chip','promo_cash','promo_chip','rakeback','hotel','transportation','transport_air','transport_grab','tournament_ticket','other')), -- free_chip, transportation: old records only
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
