CREATE TABLE IF NOT EXISTS room(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS attempts(ip TEXT PRIMARY KEY,started INTEGER NOT NULL,count INTEGER NOT NULL);
INSERT OR IGNORE INTO room(id,version,data) VALUES(1,0,'{"queue":[],"counters":{"25 / 50 NLH":1,"50 / 50 NLH":1,"50 / 100 NLH":1,"100 / 100 NLH":1,"100 / 200 NLH":1,"25 / 50 PLO":1,"50 / 50 PLO":1,"50 / 100 PLO":1,"100 / 100 PLO":1,"100 / 200 PLO":1,"25 / 50 Others":1,"50 / 50 Others":1,"50 / 100 Others":1,"100 / 100 Others":1,"100 / 200 Others":1},"occupied":[[0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0,0]],"games":["50 / 100","50 / 100","100 / 200","25 / 50"],"tableTypes":["NLH","NLH","NLH","NLH"],"calls":{},"count":"4"}');


CREATE TABLE IF NOT EXISTS ppm(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,data TEXT NOT NULL);
INSERT OR IGNORE INTO ppm VALUES(1,0,'[]');
