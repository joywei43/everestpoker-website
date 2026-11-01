CREATE TABLE IF NOT EXISTS room(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS attempts(ip TEXT PRIMARY KEY,started INTEGER NOT NULL,count INTEGER NOT NULL);
INSERT OR IGNORE INTO room(id,version,data) VALUES(1,0,'{"queue":[],"counters":{"25 / 50 NLH":1,"50 / 50 NLH":1,"50 / 100 NLH":1,"100 / 100 NLH":1,"100 / 200 NLH":1,"25 / 50 PLO":1,"50 / 50 PLO":1,"50 / 100 PLO":1,"100 / 100 PLO":1,"100 / 200 PLO":1,"25 / 50 Others":1,"50 / 50 Others":1,"50 / 100 Others":1,"100 / 100 Others":1,"100 / 200 Others":1},"occupied":[[0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0]],"games":["50 / 100","50 / 100","100 / 200","25 / 50"],"tableTypes":["NLH","NLH","NLH","NLH"],"calls":{},"count":"4"}');


CREATE TABLE IF NOT EXISTS ppm(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,data TEXT NOT NULL);
INSERT OR IGNORE INTO ppm VALUES(1,0,'[]');

-- ===== Member system (phase 1: staff console) =====
-- Safe to run again on the live database: every statement is CREATE IF NOT EXISTS / INSERT OR IGNORE.

-- Player groups: one per host, plus In-House owned by Marketing.
CREATE TABLE IF NOT EXISTS member_groups(
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('host','inhouse')),
 owner TEXT NOT NULL,
 sort INTEGER NOT NULL DEFAULT 0,
 active INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO member_groups(id,name,kind,owner,sort) VALUES
 ('hee','Hee','host','Hee',1),
 ('dee','Dee','host','Dee',2),
 ('sk','SK','host','SK',3),
 ('patrick','Patrick','host','Patrick',4),
 ('joy','JOY','host','JOY',5),
 ('inhouse','In-House','inhouse','Marketing',6);

CREATE TABLE IF NOT EXISTS members(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 member_no TEXT NOT NULL UNIQUE COLLATE NOCASE,
 surname TEXT NOT NULL DEFAULT '',
 middle_name TEXT NOT NULL DEFAULT '',
 family_name TEXT NOT NULL DEFAULT '',
 nickname TEXT NOT NULL DEFAULT '',
 nationality TEXT NOT NULL DEFAULT '',
 birthday TEXT NOT NULL DEFAULT '',
 passport_id TEXT NOT NULL DEFAULT '',
 email TEXT NOT NULL DEFAULT '',
 phone TEXT NOT NULL DEFAULT '',
 whatsapp TEXT NOT NULL DEFAULT '',
 telegram TEXT NOT NULL DEFAULT '',
 line TEXT NOT NULL DEFAULT '',
 referral_id TEXT NOT NULL DEFAULT '',
 language TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','banned')),
 staff_notes TEXT NOT NULL DEFAULT '',
 group_id TEXT REFERENCES member_groups(id),
 source TEXT NOT NULL DEFAULT '',
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS members_nickname ON members(nickname COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS members_group ON members(group_id);

-- Every group change. Hours and rewards are credited to the group in force at the time.
CREATE TABLE IF NOT EXISTS member_group_history(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 member_id INTEGER NOT NULL REFERENCES members(id),
 group_id TEXT REFERENCES member_groups(id),
 effective_from INTEGER NOT NULL,
 changed_by TEXT NOT NULL DEFAULT '',
 note TEXT NOT NULL DEFAULT '',
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS group_history_member ON member_group_history(member_id,effective_from);

-- One row per finished PPM seat session. group_id is the player's group at seat-in time.
CREATE TABLE IF NOT EXISTS play_sessions(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 session_key TEXT NOT NULL UNIQUE,
 member_id INTEGER REFERENCES members(id),
 member_ref TEXT NOT NULL,
 group_id TEXT,
 play_date TEXT NOT NULL,
 table_name TEXT NOT NULL DEFAULT '',
 seat INTEGER NOT NULL DEFAULT 0,
 game_type TEXT NOT NULL DEFAULT '',
 blinds TEXT NOT NULL DEFAULT '',
 start_at INTEGER NOT NULL,
 end_at INTEGER NOT NULL,
 active_seconds INTEGER NOT NULL DEFAULT 0,
 rest_seconds INTEGER NOT NULL DEFAULT 0,
 buy_in INTEGER,
 transfer_note TEXT,
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_member ON play_sessions(member_id,start_at);
CREATE INDEX IF NOT EXISTS sessions_group ON play_sessions(group_id,start_at);

-- Everything given to a player, in pesos. Voided instead of deleted.
-- free_chip = Free Chip (PromoChip), promo_cash = Promotion-Cash, promo_chip = Promotion-Chip,
-- hotel = Hotel Stay, transportation = Transportation, tournament_ticket = Tournament Tickets.
CREATE TABLE IF NOT EXISTS rewards(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 member_id INTEGER NOT NULL REFERENCES members(id),
 group_id TEXT,
 type TEXT NOT NULL CHECK(type IN ('free_chip','promo_cash','promo_chip','hotel','transportation','tournament_ticket')),
 detail TEXT NOT NULL DEFAULT '',
 amount INTEGER NOT NULL CHECK(amount>=0),
 given_at INTEGER NOT NULL,
 recorded_by TEXT NOT NULL,
 approved_by TEXT NOT NULL DEFAULT '',
 voided INTEGER NOT NULL DEFAULT 0,
 void_reason TEXT NOT NULL DEFAULT '',
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rewards_member ON rewards(member_id,given_at);
CREATE INDEX IF NOT EXISTS rewards_group ON rewards(group_id,given_at);

CREATE TABLE IF NOT EXISTS audit_log(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 at INTEGER NOT NULL,
 actor TEXT NOT NULL DEFAULT '',
 action TEXT NOT NULL,
 member_id INTEGER,
 detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS audit_member ON audit_log(member_id,at);

CREATE TABLE IF NOT EXISTS register_attempts(ip TEXT PRIMARY KEY,started INTEGER NOT NULL,count INTEGER NOT NULL);
