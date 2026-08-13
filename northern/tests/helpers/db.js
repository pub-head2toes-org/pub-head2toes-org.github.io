'use strict';

import fs from 'node:fs';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import SqliteDB from '../../src/h2t/SqliteDB.js';

export const REPO_ROOT = path.join(import.meta.dirname, '..', '..');
export const TMP_DIR = path.join(REPO_ROOT, 'tests', '.tmp');

/**
 * SqliteDB resolves its file relative to src/h2t, so tests hand it a path
 * of the form ../../tests/.tmp/<name>.db and get back both forms.
 */
export function tmpDbPaths(name) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const absolute = path.join(TMP_DIR, name);
    fs.rmSync(absolute, { force: true });
    return { absolute, relativeToSrcH2t: `../../tests/.tmp/${name}` };
}

/**
 * Creates the schema up front.
 *
 * SqliteDB's constructor issues CREATE TABLE and CREATE UNIQUE INDEX without
 * serializing them, so on a brand new file the index creation loses the race
 * and never happens (see REFACTORING.md #2). Tests need the unique index to be
 * present, since auto-versioning is driven by its constraint violation.
 */
export async function seedSchema(absoluteDbPath) {
    const seed = new sqlite3.Database(absoluteDbPath);
    await new Promise((resolve, reject) => seed.run(
        'CREATE TABLE IF NOT EXISTS abcd (path TEXT, type TEXT, value TEXT, counter INTEGER, author TEXT, public TEXT)',
        err => err ? reject(err) : resolve()));
    await new Promise((resolve, reject) => seed.run(
        'CREATE UNIQUE INDEX IF NOT EXISTS PathUniqueIndex ON abcd (path)',
        err => err ? reject(err) : resolve()));
    await new Promise((resolve, reject) => seed.close(err => err ? reject(err) : resolve()));
}

/** Fresh, schema-ready SqliteDB instance backed by tests/.tmp/<name>. */
export async function freshDb(name) {
    const paths = tmpDbPaths(name);
    await seedSchema(paths.absolute);
    return { db: new SqliteDB(paths.relativeToSrcH2t), ...paths };
}

// The DB API takes a single-argument callback rather than (err, data).
export const promisify1 = (fn, self) => (...args) =>
    new Promise(resolve => fn.call(self, ...args, resolve));
