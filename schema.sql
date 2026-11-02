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
 approved_at INTEGER, -- NULL = waiting for a manager; only approved rewards count in cost totals
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

-- Staff accounts. Passwords are stored as salted PBKDF2-SHA256 hashes, never in plain text.
-- Create or reset accounts with: node create-staff.mjs "Name:password" ... > staff-accounts.sql  (do not commit that file)
CREATE TABLE IF NOT EXISTS staff(
 username TEXT PRIMARY KEY COLLATE NOCASE,
 display_name TEXT NOT NULL,
 pw_hash TEXT NOT NULL,
 salt TEXT NOT NULL,
 iterations INTEGER NOT NULL,
 role TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('admin','staff')), -- admin = manager, staff = floor/counter
 active INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL
);
-- Which staff member owns each login session (token is the same hash stored in sessions).
CREATE TABLE IF NOT EXISTS session_users(token TEXT PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'admin');

-- ===== Member app (phase 2) =====
-- Members sign in with member number + birthday. Sessions last 30 days.
CREATE TABLE IF NOT EXISTS member_sessions(token TEXT PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id), expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS member_login_attempts(ip TEXT PRIMARY KEY, started INTEGER NOT NULL, count INTEGER NOT NULL);
-- Promotions shown in the member app, edited by managers in the console.
CREATE TABLE IF NOT EXISTS promotions(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 title TEXT NOT NULL,
 body TEXT NOT NULL DEFAULT '',
 starts TEXT NOT NULL DEFAULT '',
 ends TEXT NOT NULL DEFAULT '',
 active INTEGER NOT NULL DEFAULT 1,
 sort INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);

-- Member photos (small JPEG, resized in the browser before upload). Taken by staff at the counter.
CREATE TABLE IF NOT EXISTS member_photos(member_id INTEGER PRIMARY KEY REFERENCES members(id), data TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL DEFAULT '');

-- Old member numbers after a master renumbers a member. PPM seats typed with an old number still match.
CREATE TABLE IF NOT EXISTS member_number_history(old_no TEXT PRIMARY KEY COLLATE NOCASE, member_id INTEGER NOT NULL REFERENCES members(id), changed_at INTEGER NOT NULL, changed_by TEXT NOT NULL DEFAULT '');

-- A name typed on a PPM seat that staff linked to a member while the player was still at the table.
-- seat_key = table|seat|typed name|seat-in time, so it only applies to that one sitting.
CREATE TABLE IF NOT EXISTS ppm_seat_links(seat_key TEXT PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id), created_at INTEGER NOT NULL, created_by TEXT NOT NULL DEFAULT '');

-- Unify nationality spellings (Taiwanese / TW / 台灣 → Taiwan, …). Safe to run again.
UPDATE members SET nationality='Taiwan' WHERE nationality<>'Taiwan' AND lower(trim(nationality)) IN ('taiwan','taiwanese','tw','twn','roc','republic of china','taiwan roc','台灣','臺灣','中華民國','台湾');
UPDATE members SET nationality='Philippines' WHERE nationality<>'Philippines' AND lower(trim(nationality)) IN ('philippines','philippine','filipino','filipina','ph','phl','pilipinas','菲律賓','菲律宾');
UPDATE members SET nationality='South Korea' WHERE nationality<>'South Korea' AND lower(trim(nationality)) IN ('south korea','korea','korean','republic of korea','rok','kr','kor','韓國','韩国','대한민국','한국');
UPDATE members SET nationality='Japan' WHERE nationality<>'Japan' AND lower(trim(nationality)) IN ('japan','japanese','jp','jpn','日本');
UPDATE members SET nationality='Hong Kong' WHERE nationality<>'Hong Kong' AND lower(trim(nationality)) IN ('hong kong','hongkong','hk','hkg','hong kong sar','香港');
UPDATE members SET nationality='Macau' WHERE nationality<>'Macau' AND lower(trim(nationality)) IN ('macau','macao','mo','mac','澳門','澳门');
UPDATE members SET nationality='China' WHERE nationality<>'China' AND lower(trim(nationality)) IN ('china','chinese','prc','cn','chn','people''s republic of china','mainland china','中國','中国','大陸','大陆');
UPDATE members SET nationality='Singapore' WHERE nationality<>'Singapore' AND lower(trim(nationality)) IN ('singapore','singaporean','sg','sgp','新加坡');
UPDATE members SET nationality='Thailand' WHERE nationality<>'Thailand' AND lower(trim(nationality)) IN ('thailand','thai','th','tha','泰國','泰国');
UPDATE members SET nationality='Indonesia' WHERE nationality<>'Indonesia' AND lower(trim(nationality)) IN ('indonesia','indonesian','id','idn','印尼','印度尼西亞','印度尼西亚');
UPDATE members SET nationality='Malaysia' WHERE nationality<>'Malaysia' AND lower(trim(nationality)) IN ('malaysia','malaysian','my','mys','馬來西亞','马来西亚');
UPDATE members SET nationality='Vietnam' WHERE nationality<>'Vietnam' AND lower(trim(nationality)) IN ('vietnam','viet nam','vietnamese','vn','vnm','越南');
UPDATE members SET nationality='India' WHERE nationality<>'India' AND lower(trim(nationality)) IN ('india','indian','in','ind','印度');
UPDATE members SET nationality='United States' WHERE nationality<>'United States' AND lower(trim(nationality)) IN ('united states','united states of america','usa','us','u.s.','u.s.a.','america','american','美國','美国');
UPDATE members SET nationality='Canada' WHERE nationality<>'Canada' AND lower(trim(nationality)) IN ('canada','canadian','ca','can','加拿大');
UPDATE members SET nationality='Australia' WHERE nationality<>'Australia' AND lower(trim(nationality)) IN ('australia','australian','au','aus','澳洲','澳大利亞','澳大利亚');
UPDATE members SET nationality='United Kingdom' WHERE nationality<>'United Kingdom' AND lower(trim(nationality)) IN ('united kingdom','uk','u.k.','gb','gbr','great britain','britain','british','england','english','英國','英国');

-- Cash-out recorded when a player leaves the seat in PPM (or entered later by a manager). busted=1: lost the whole buy-in.
-- Kept beside play_sessions so the existing table is never altered.
CREATE TABLE IF NOT EXISTS session_results(session_id INTEGER PRIMARY KEY REFERENCES play_sessions(id), cash_out INTEGER NOT NULL CHECK(cash_out>=0), busted INTEGER NOT NULL DEFAULT 0, entered_by TEXT NOT NULL DEFAULT 'PPM', updated_at INTEGER NOT NULL);
