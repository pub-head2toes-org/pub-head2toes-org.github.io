'use strict';

import fs from 'node:fs';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import SezamBuild from '../../src/h2t/SezamBuild.js';
import { TMP_DIR } from './db.js';

/**
 * The archive's own DDL, copied verbatim from sezam.db.
 *
 * The 10 000-message db/sample.db is not the fixture: it has no indexes, no
 * FTS, and empty-string roots, so tests built on it would exercise a shape the
 * production archive does not have and would miss every search path. This
 * builds a miniature of the real thing instead - same tables, same eleven
 * indexes, same two contentless FTS5 tables.
 */
export const ARCHIVE_DDL = [
`CREATE TABLE conference(
  id INTEGER PRIMARY KEY, family TEXT NOT NULL, volume TEXT NOT NULL UNIQUE,
  ord INTEGER NOT NULL DEFAULT 0,
  date_from TEXT, date_to TEXT, msg_count INTEGER DEFAULT 0)`,
`CREATE TABLE topic(
  id INTEGER PRIMARY KEY, conf_id INTEGER NOT NULL REFERENCES conference(id),
  name TEXT NOT NULL, declared_count INTEGER, msg_count INTEGER DEFAULT 0,
  first_ts TEXT, last_ts TEXT, UNIQUE(conf_id, name))`,
`CREATE TABLE author(
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE,
  msg_count INTEGER DEFAULT 0, first_ts TEXT, last_ts TEXT, user_id INTEGER REFERENCES user(id))`,
`CREATE TABLE message(
  id INTEGER PRIMARY KEY,
  topic_id INTEGER NOT NULL REFERENCES topic(id),
  seq INTEGER NOT NULL,
  author_id INTEGER NOT NULL REFERENCES author(id),
  ts TEXT, epoch INTEGER, ts_raw TEXT,
  reply_seq INTEGER, reply_author TEXT,
  year INTEGER,
  body TEXT NOT NULL,
  UNIQUE(topic_id, seq))`,
`CREATE TABLE user(
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  full_name TEXT, city TEXT, company TEXT,
  member_since TEXT, member_since_iso TEXT,
  last_seen TEXT,  last_seen_iso TEXT,
  found_via TEXT, fetched_at TEXT, last_seen_observed TEXT, last_seen_clamped INTEGER DEFAULT 0)`,
'CREATE INDEX ix_msg_author  ON message(author_id, epoch)',
'CREATE INDEX ix_msg_author_id ON message(author_id, id)',
'CREATE INDEX ix_msg_topic   ON message(topic_id, seq)',
'CREATE INDEX ix_msg_epoch   ON message(epoch)',
'CREATE INDEX ix_msg_year    ON message(year)',
'CREATE INDEX ix_msg_reply   ON message(topic_id, reply_seq)',
'CREATE INDEX ix_topic_conf  ON topic(conf_id)',
'CREATE INDEX ix_conf_family ON conference(family, ord)',
'CREATE INDEX ix_user_city ON user(city)',
'CREATE INDEX ix_user_name ON user(full_name)',
'CREATE INDEX ix_author_user ON author(user_id)',
`CREATE VIRTUAL TABLE user_search USING fts5(
  username, full_name, city, company, content='',
  tokenize="unicode61 remove_diacritics 2")`,
`CREATE VIRTUAL TABLE search USING fts5(
  body, author, topic, person, content='',
  tokenize="unicode61 remove_diacritics 2")`
];

const DAY = 86400;
const base = Date.UTC(1995, 0, 1) / 1000;

/**
 * The corpus every test reads.
 *
 * Small, but it carries one of each thing the findings say the real archive
 * contains: an empty-string root, a self-reference, a forward reference, an
 * orphan, a 70-deep chain (the real deepest is 81, and the first draft's
 * ceiling of 64 would have cut it), a reply_author that disagrees with the
 * parent's actual author, diacritics in both names and bodies, and messages
 * spread across years.
 */
export const FIXTURE = buildCorpus();

function buildCorpus (){
    const conferences = [
        { id: 1, family: 'AMIGA', volume: 'AMIGA.2',  ord: 2,  date_from: '03 Feb 1995', date_to: '16 Dec 1997' },
        { id: 2, family: 'FORUM', volume: 'FORUM.2',  ord: 2,  date_from: '11 Jan 1995', date_to: '20 Nov 1996' },
        { id: 3, family: 'FORUM', volume: 'FORUM.10', ord: 10, date_from: '01 Mar 1996', date_to: '09 Sep 1997' }
    ];
    const topics = [
        { id: 1, conf_id: 1, name: 'asembler',   declared_count: 99 },
        { id: 2, conf_id: 1, name: 'grafika i štampa', declared_count: 4 },
        { id: 3, conf_id: 2, name: 'politika',   declared_count: null },
        { id: 4, conf_id: 3, name: 'duboka nit', declared_count: 1 }
    ];
    const users = [
        { id: 1, username: 'rcolic',   full_name: 'Rastko Čolić',      city: 'Beograd', company: 'Mikro knjiga' },
        { id: 2, username: 'mristan',  full_name: 'Milan Ristanović',  city: 'Niš',     company: null },
        { id: 3, username: 'dejanr',   full_name: 'Dejan Ristanovic',  city: 'Beograd', company: 'Računari' },
        { id: 4, username: 'mikis',    full_name: 'Miloš Šarić',       city: 'Novi Sad', company: null },
        { id: 5, username: 'quiet',    full_name: 'Ana Jovanović',     city: 'Čačak',   company: 'Energoprojekt' }
    ];
    const authors = [
        { id: 1, username: 'rcolic',  user_id: 1 },
        { id: 2, username: 'mristan', user_id: 2 },
        { id: 3, username: 'dejanr',  user_id: 3 },
        { id: 4, username: 'mikis',   user_id: 4 },
        { id: 5, username: 'ghost',   user_id: null }   // 83 authors in the archive have no user
    ];
    const messages = [];
    const add = (topic_id, seq, author_id, reply_seq, body, { year = 1995, day = seq, reply_author } = {}) => {
        const epoch = base + (year - 1995) * 365 * DAY + day * DAY;
        const parent = messages.find(m => m.topic_id === topic_id && m.seq === reply_seq);
        messages.push({
            id: messages.length + 1, topic_id, seq, author_id,
            ts: new Date(epoch * 1000).toISOString().slice(0, 16),
            epoch, ts_raw: null, reply_seq,
            reply_author: reply_author !== undefined
                ? reply_author
                : (parent ? authors.find(a => a.id === parent.author_id).username : null),
            year, body
        });
    };

    // Topic 1 - two ordinary threads, one of them branching.
    add(1, 1, 1, null, 'Sto se tice SyberStorm-a: upgrade your A4000 with the new CyberStorm Modular Accelerator.');
    add(1, 2, 2, 1,    'A koliko to kosta? Amiga je i dalje skupa masina.');
    add(1, 3, 3, 2,    'Kosta koliko i ceo PC. Video sam reklamu za Amigin klon DRACO.');
    add(1, 4, 4, 1,    'Druga grana iste niti - odgovor na prvu poruku, ne na drugu.');
    add(1, 5, 1, null, 'Nova nit u istoj temi. Asembler na 68030 je zadovoljstvo.');
    add(1, 6, 2, 5,    'Slazem se, ali C je prenosiv.');

    // Topic 2 - the damaged edges, one of each kind.
    add(2, 1, 3, '',   'Root stored as the empty string, the way db/sample.db keeps them.');
    add(2, 2, 1, 2,    'Self reference: reply_seq equals seq.');
    add(2, 3, 2, 9,    'Forward reference: names a seq that comes later.');
    add(2, 4, 4, 77,   'Orphan: names a parent that is not in the table.', { reply_author: 'nobody' });
    add(2, 5, 1, 1,    'An ordinary reply to the empty-string root.');
    // reply_author disagreeing with the parent's real author - 575 rows do this.
    add(2, 6, 3, 5,    'The reply_author column says mikis, but seq 5 was posted by rcolic.',
        { reply_author: 'mikis' });

    // Topic 3 - years and diacritics, for the date and search filters.
    add(3, 1, 3, null, 'Racunari i politika devedesetih. Tekst bez dijakritike.', { year: 1995, day: 10 });
    add(3, 2, 2, 1,    'Odgovor sa dijakritikom: Ristanović je pisao o tome.',   { year: 1996, day: 20 });
    add(3, 3, 5, 1,    'Treca poruka, druga godina, drugi autor.',               { year: 1997, day: 30 });
    add(3, 4, 1, 3,    'Amiga i Atari su bili jeftiniji od PC-a.',               { year: 1997, day: 31 });

    // Topic 4 - a 70 deep chain. The archive's deepest is 81; a ceiling of 64
    // would cut this one, which is exactly what it is here to catch.
    add(4, 1, 1, null, 'Duboka nit, poruka 1.');
    for (let seq = 2; seq <= 70; seq++){
        add(4, seq, (seq % 5) + 1, seq - 1, `Duboka nit, poruka ${seq}.`);
    }

    return { conferences, topics, authors, users, messages };
}

/**
 * Writes the fixture archive, then builds its thread sidecar with the real
 * SezamBuild - the builder is under test, not stubbed.
 *
 * `inline` copies the sidecar's tables into the archive instead of leaving
 * them in their own file, which is the layout a fixture or a future prebuilt
 * archive would have, and the branch SezamDB takes without attaching.
 */
export async function buildFixture (name, { inline = false, corpus = FIXTURE, fts = true } = {}){
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const archive = path.join(TMP_DIR, name);
    const sidecar = path.join(TMP_DIR, name.replace(/(\.db)?$/, '') + '-thread.db');
    for (const file of [archive, sidecar, `${sidecar}.building`]){
        fs.rmSync(file, { force: true });
    }

    const db = await open(archive);
    for (const statement of ARCHIVE_DDL){
        await run(db, statement);
    }
    await seed(db, corpus, fts);
    await close(db);

    await new SezamBuild({ log: () => {} }).build(archive, sidecar);

    if (inline){
        await inlineSidecar(archive, sidecar);
        return { archive, thread: null, sidecar, cleanup: () => cleanup([archive, sidecar]) };
    }
    return { archive, thread: sidecar, sidecar, cleanup: () => cleanup([archive, sidecar]) };
}

/**
 * `fts: false` leaves the search index unpopulated, so its count disagrees
 * with the message table - which is the one thing a contentless FTS table
 * lets the API notice, since it cannot be rebuilt or integrity-checked.
 */
async function seed (db, corpus, fts = true){
    const { conferences, topics, authors, users, messages } = corpus;
    await run(db, 'BEGIN');
    for (const c of conferences){
        await run(db, 'INSERT INTO conference(id, family, volume, ord, date_from, date_to, msg_count) VALUES (?,?,?,?,?,?,0)',
            [c.id, c.family, c.volume, c.ord, c.date_from, c.date_to]);
    }
    for (const t of topics){
        await run(db, 'INSERT INTO topic(id, conf_id, name, declared_count, msg_count) VALUES (?,?,?,?,0)',
            [t.id, t.conf_id, t.name, t.declared_count]);
    }
    for (const u of users){
        await run(db, `INSERT INTO user(id, username, full_name, city, company, member_since, member_since_iso)
                       VALUES (?,?,?,?,?,?,?)`,
            [u.id, u.username, u.full_name, u.city, u.company, '01 Jan 1995', '1995-01-01']);
        // rowid = user.id, exactly as in the archive
        await run(db, 'INSERT INTO user_search(rowid, username, full_name, city, company) VALUES (?,?,?,?,?)',
            [u.id, u.username, u.full_name, u.city, u.company]);
    }
    for (const a of authors){
        await run(db, 'INSERT INTO author(id, username, msg_count, user_id) VALUES (?,?,0,?)',
            [a.id, a.username, a.user_id]);
    }
    for (const m of messages){
        await run(db, `INSERT INTO message(id, topic_id, seq, author_id, ts, epoch, ts_raw, reply_seq, reply_author, year, body)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [m.id, m.topic_id, m.seq, m.author_id, m.ts, m.epoch, m.ts_raw, m.reply_seq, m.reply_author, m.year, m.body]);
        const author = authors.find(a => a.id === m.author_id);
        const user = author.user_id ? users.find(u => u.id === author.user_id) : null;
        const topic = topics.find(t => t.id === m.topic_id);
        // search.person carries the handle and the linked full name together,
        // which is what makes person: search work across the whole archive.
        if (fts){
            await run(db, 'INSERT INTO search(rowid, body, author, topic, person) VALUES (?,?,?,?,?)',
                [m.id, m.body, author.username, topic.name,
                 user ? `${author.username} ${user.full_name}` : author.username]);
        }
    }
    // msg_count is exact in the archive - 0 mismatches across topic, conference
    // and author - which is what lets the API use it as a free total.
    await run(db, 'UPDATE topic SET msg_count = (SELECT count(*) FROM message WHERE topic_id = topic.id)');
    await run(db, `UPDATE topic SET first_ts = (SELECT min(ts) FROM message WHERE topic_id = topic.id),
                                    last_ts  = (SELECT max(ts) FROM message WHERE topic_id = topic.id)`);
    await run(db, `UPDATE conference SET msg_count = (SELECT count(*) FROM message m
                     JOIN topic t ON t.id = m.topic_id WHERE t.conf_id = conference.id)`);
    await run(db, 'UPDATE author SET msg_count = (SELECT count(*) FROM message WHERE author_id = author.id)');
    await run(db, `UPDATE author SET first_ts = (SELECT min(ts) FROM message WHERE author_id = author.id),
                                     last_ts  = (SELECT max(ts) FROM message WHERE author_id = author.id)`);
    await run(db, 'COMMIT');
}

async function inlineSidecar (archive, sidecar){
    const db = await open(archive);
    await run(db, `ATTACH DATABASE '${sidecar}' AS x`);
    await run(db, 'CREATE TABLE message_thread AS SELECT * FROM x.message_thread');
    await run(db, 'CREATE TABLE thread AS SELECT * FROM x.thread');
    await run(db, 'CREATE TABLE build_info AS SELECT * FROM x.build_info');
    await run(db, 'CREATE UNIQUE INDEX ix_mt_pk ON message_thread(topic_id, seq)');
    await run(db, 'CREATE INDEX ix_mt_read ON message_thread(topic_id, root_seq, ord)');
    await run(db, 'CREATE INDEX ix_mt_roots ON message_thread(topic_id, root_seq) WHERE depth = 0');
    await run(db, 'CREATE UNIQUE INDEX ix_thread_pk ON thread(topic_id, root_seq)');
    await run(db, 'CREATE INDEX ix_thread_last ON thread(topic_id, last_epoch)');
    await close(db);
}

function cleanup (files){
    for (const file of files){
        fs.rmSync(file, { force: true });
    }
}

const open = file => new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, err => err ? reject(err) : resolve(db));
});
const run = (db, sql, params = []) =>
    new Promise((resolve, reject) => db.run(sql, params, err => err ? reject(err) : resolve()));
const close = db => new Promise((resolve, reject) => db.close(err => err ? reject(err) : resolve()));
