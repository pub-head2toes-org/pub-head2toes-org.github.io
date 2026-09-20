CREATE TABLE conference(
  id INTEGER PRIMARY KEY, family TEXT NOT NULL, volume TEXT NOT NULL UNIQUE,
  ord INTEGER NOT NULL DEFAULT 0,     -- numeric volume no.; "FORUM.10" > "FORUM.2"
  date_from TEXT, date_to TEXT, msg_count INTEGER DEFAULT 0);
CREATE TABLE topic(
  id INTEGER PRIMARY KEY, conf_id INTEGER NOT NULL REFERENCES conference(id),
  name TEXT NOT NULL, declared_count INTEGER, msg_count INTEGER DEFAULT 0,
  first_ts TEXT, last_ts TEXT, UNIQUE(conf_id, name));
CREATE TABLE author(
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE,
  msg_count INTEGER DEFAULT 0, first_ts TEXT, last_ts TEXT, user_id INTEGER REFERENCES user(id));
CREATE TABLE message(
  id INTEGER PRIMARY KEY,
  topic_id INTEGER NOT NULL REFERENCES topic(id),
  seq INTEGER NOT NULL,
  author_id INTEGER NOT NULL REFERENCES author(id),
  ts TEXT, epoch INTEGER, ts_raw TEXT,
  reply_seq INTEGER, reply_author TEXT,
  year INTEGER,                       -- denormalised: substr(ts,1,4) cannot use an index
  body TEXT NOT NULL,
  UNIQUE(topic_id, seq));
CREATE TABLE user(
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  full_name TEXT, city TEXT, company TEXT,
  member_since TEXT, member_since_iso TEXT,
  last_seen TEXT,  last_seen_iso TEXT,
  found_via TEXT, fetched_at TEXT, last_seen_observed TEXT, last_seen_clamped INTEGER DEFAULT 0);
