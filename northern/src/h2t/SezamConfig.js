'use strict';

import fs from 'node:fs';

export const CONFIG_PATH = '/config/sezam';

// A failed lookup is remembered only briefly, so an operator can insert the
// config row into abcd and see the API come up without restarting the node.
export const NEGATIVE_TTL_MS = 30000;

/**
 * Where the Sezam archive lives on this node.
 *
 * The archive is 773 MB. It is not in git, not under src/fs/ (everything there
 * is downloadable through /fs/get/), and not a constant in the source - it is a
 * configuration parameter, read from the abcd store the node already opens.
 *
 * Precedence: SEZAM_DB in the environment, then the abcd row, then unavailable.
 * The environment wins so that tests can point at a fixture and a second node
 * can read the same archive without a second abcd edit.
 */
export default class SezamConfig {
    constructor(db, { env = process.env, now = () => Date.now(), log = console.log } = {}) {
        this.db = db;
        this.env = env;
        this.now = now;
        this.log = log;
        this.resolved = null;      // a success, cached for the process lifetime
        this.failedAt = 0;         // a failure, cached for NEGATIVE_TTL_MS only
        this.failure = null;
        this.inFlight = null;
    }

    /**
     * Resolves to { available: true, db, thread } or { available: false, reason }.
     *
     * `reason` is for the operator's log, never for the response body: it names
     * a filesystem path, and keeping that path off the wire is the whole point
     * of storing the config row privately.
     */
    resolve() {
        if (this.resolved){
            return Promise.resolve(this.resolved);
        }
        if (this.failure && this.now() - this.failedAt < NEGATIVE_TTL_MS){
            return Promise.resolve(this.failure);
        }
        // Concurrent first requests share one lookup rather than racing to read
        // the same row.
        if (!this.inFlight){
            this.inFlight = this.lookup().then(result => {
                this.inFlight = null;
                return this.remember(result);
            }, err => {
                this.inFlight = null;
                return this.remember(unavailable('config-error', err.message));
            });
        }
        return this.inFlight;
    }

    remember (result){
        if (result.available){
            this.resolved = result;
            this.failure = null;
        } else {
            this.failure = result;
            this.failedAt = this.now();
            this.log('sezam: archive unavailable:', result.reason);
        }
        return result;
    }

    /** Forgets both caches - the build script uses this after writing a sidecar. */
    reset (){
        this.resolved = null;
        this.failure = null;
        this.failedAt = 0;
        return this;
    }

    async lookup (){
        const fromEnv = this.readEnv();
        if (fromEnv){
            return this.check(fromEnv, 'SEZAM_DB');
        }
        const fromAbcd = await this.readAbcd();
        if (!fromAbcd.available){
            return fromAbcd;
        }
        return this.check(fromAbcd, CONFIG_PATH);
    }

    readEnv (){
        const dbPath = (this.env.SEZAM_DB || '').trim();
        if (!dbPath){
            return null;
        }
        return { db: dbPath, thread: (this.env.SEZAM_THREAD_DB || '').trim() || null };
    }

    async readAbcd (){
        if (!this.db || typeof this.db.getConfig !== 'function'){
            return unavailable('no-config', 'no abcd store to read from');
        }
        const row = await this.db.getConfig(CONFIG_PATH);
        if (!row){
            return unavailable('no-config', `no ${CONFIG_PATH} row in abcd`);
        }
        // Render.render serves any abcd row whose public column is 'public', so a
        // config row stored that way would hand every visitor a server
        // filesystem path at GET /config/sezam. Refusing it here is the only
        // place that leak can be caught before it is live.
        if (row.public === 'public'){
            return unavailable('public-config',
                `${CONFIG_PATH} is stored public and would be served to anyone; store it under the operator's key`);
        }
        let parsed;
        try {
            parsed = JSON.parse(row.value);
        } catch (err) {
            return unavailable('bad-json', `${CONFIG_PATH} is not valid JSON: ${err.message}`);
        }
        const dbPath = typeof parsed?.db === 'string' ? parsed.db.trim() : '';
        if (!dbPath){
            return unavailable('no-db-path', `${CONFIG_PATH} has no "db" key`);
        }
        const thread = typeof parsed?.thread === 'string' ? parsed.thread.trim() : '';
        return { available: true, db: dbPath, thread: thread || null };
    }

    check (candidate, source){
        const dbPath = candidate.db;
        if (!fs.existsSync(dbPath)){
            return unavailable('missing', `${source} points at ${dbPath}, which does not exist`);
        }
        try {
            fs.accessSync(dbPath, fs.constants.R_OK);
        } catch (err) {
            return unavailable('unreadable', `${dbPath} is not readable: ${err.message}`);
        }
        return { available: true, db: dbPath, thread: candidate.thread || defaultThreadPath(dbPath), source };
    }
}

/** The sidecar sits beside the archive: sezam.db -> sezam-thread.db. */
export function defaultThreadPath (dbPath){
    return dbPath.replace(/(\.db)?$/, '') + '-thread.db';
}

function unavailable (reason, detail){
    return { available: false, reason: detail ? `${reason}: ${detail}` : reason, code: reason };
}
