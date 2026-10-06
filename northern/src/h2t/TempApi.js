'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import pathModule from 'node:path';
import { pipeline } from 'node:stream/promises';

const MB = 1024 * 1024;
// The whole temp space, and the most one file may take of it (UPDATE_8).
export const MAX_SPACE = 500 * MB;
export const MAX_FILE = 50 * MB;
// A file nobody has downloaded is let go after a month.
export const EXPIRY = 30 * 24 * 3600 * 1000;
// Below 10% free, files nobody has downloaded yet are marked too, oldest first.
export const LOW = 0.10;
// Below 30% free, every marked file is purged.
export const PURGE = 0.30;
// An upload that would fill the space to 90% or more purges marked files first.
export const FULL = 0.90;

// The name a file is saved under, and the only way to download it: 32 random
// bytes, base64url. Nothing else a request names is ever a path.
const ID = /^[A-Za-z0-9_-]{43}$/;
// A marked file keeps its name with this after it, until it is purged.
const MARKED = '.del';
// An upload on its way in. It is in nobody's hands until it is whole.
const PART = '.part';
// What a form on another site can post without a preflight.
const SIMPLE = /^(text\/plain|multipart\/form-data|application\/x-www-form-urlencoded)\b/i;

export class TempError extends Error {
    constructor(status, code, message){
        super(message);
        this.status = status;
        this.code = code;
    }
}
const fail = (status, code, message) => { throw new TempError(status, code, message); };

/**
 * Temporary file hold, mounted at /temp/api/.
 *
 *   POST /temp/api/upload          the request body is the file; answers its id
 *   GET  /temp/api/download/<id>   the file, as bytes
 *
 * A file is opaque here - an image, or the same image AES-sealed in the
 * browser - and is served back only as application/octet-stream. Uploading
 * takes a signed session; downloading takes only the id, so a pal can fetch
 * what was sent to them.
 *
 * A file is kept until it is marked for deletion and then purged:
 *   - it is marked once downloaded, or when a month old;
 *   - it is marked, oldest first, when an upload would leave less than 10% free;
 *   - marked files are purged as soon as less than 30% is free, and before
 *     an upload that would fill the space to 90% or more.
 * A marked file can still be downloaded until it is purged. Marks are kept on
 * disk, so they outlive a restart.
 */
export default class TempApi {
    constructor(dir, { render, verifySsid, now = () => Date.now(), log = console.log,
                       maxSpace = MAX_SPACE, maxFile = MAX_FILE } = {}){
        this.dir = dir;
        this.render = render;
        this.verifySsid = verifySsid;
        this.now = now;
        this.log = log;
        this.maxSpace = maxSpace;
        this.maxFile = maxFile;
        // id -> { size, at, marked }, read from the folder on first use.
        this.files = null;
        this.ready = null;
        // Bytes promised to uploads still on their way in.
        this.reserved = 0;
    }

    /** True for the paths this API owns, so Server can branch on it. */
    static owns (pathname){
        return pathname === '/temp/api' || pathname.startsWith('/temp/api/');
    }

    /** The folder's files, as the index keeps them. Leftover partial uploads are dropped. */
    load (){
        if (!this.ready){
            this.ready = this.scan().catch(err => {
                this.ready = null;
                throw err;
            });
        }
        return this.ready;
    }

    async scan (){
        await fs.promises.mkdir(this.dir, { recursive: true });
        const files = new Map();
        for (const name of await fs.promises.readdir(this.dir)){
            const file = pathModule.join(this.dir, name);
            if (name.endsWith(PART)){
                await fs.promises.rm(file, { force: true });
                continue;
            }
            const marked = name.endsWith(MARKED);
            const id = marked ? name.slice(0, -MARKED.length) : name;
            if (!ID.test(id)){
                continue;
            }
            const stat = await fs.promises.stat(file);
            if (stat.isFile()){
                files.set(id, { size: stat.size, at: stat.mtimeMs, marked });
            }
        }
        this.files = files;
    }

    fileOf (id, marked){
        return pathModule.join(this.dir, id + (marked ? MARKED : ''));
    }

    /** Bytes held, marked files and uploads in flight included. */
    used (){
        let total = this.reserved;
        for (const entry of this.files.values()){
            total += entry.size;
        }
        return total;
    }

    async mark (id){
        const entry = this.files.get(id);
        if (!entry || entry.marked){
            return;
        }
        // Marked before the rename is done, so nobody marks it twice; a
        // download in between finds it under either name.
        entry.marked = true;
        try {
            await fs.promises.rename(this.fileOf(id, false), this.fileOf(id, true));
        } catch (err) {
            this.log(`temp: could not mark ${id}: ${err.message}`);
        }
    }

    async purge (){
        for (const [id, entry] of [...this.files]){
            if (entry.marked){
                this.files.delete(id);
                await fs.promises.rm(this.fileOf(id, true), { force: true });
            }
        }
    }

    /** Purges the marked files once less than 30% is free. */
    async tidy (){
        if (this.used() > this.maxSpace * (1 - PURGE)){
            await this.purge();
        }
    }

    /**
     * Makes room for `incoming` bytes, as UPDATE_8 says, and reserves them;
     * throws when they still do not fit. The last check and the reservation
     * have no await between them, so two uploads cannot both take the last of
     * the space.
     */
    async makeRoom (incoming){
        const max = this.maxSpace;
        const now = this.now();
        for (const [id, entry] of this.files){
            if (!entry.marked && now - entry.at >= EXPIRY){
                await this.mark(id);
            }
        }
        if (this.used() > max * (1 - PURGE) || this.used() + incoming >= max * FULL){
            await this.purge();
        }
        if (this.used() + incoming > max * (1 - LOW)){
            const unread = [...this.files].filter(([, entry]) => !entry.marked).sort((a, b) => a[1].at - b[1].at);
            for (const [id] of unread){
                if (this.used() + incoming <= max * (1 - LOW)){
                    break;
                }
                await this.mark(id);
                await this.purge();
            }
        }
        if (this.used() + incoming > max){
            fail(507, 'InsufficientStorage', 'the temp space is full; try again later');
        }
        this.reserved += incoming;
    }

    async handle (req, res, ssid){
        try {
            const path = new URL(req.url, 'http://x').pathname.replace(/\/+$/, '');
            await this.load();
            if (req.method === 'POST' && path === '/temp/api/upload'){
                this.render.renderJSON(await this.upload(req, ssid), res);
            } else if (req.method === 'GET' && path.startsWith('/temp/api/download/')){
                await this.download(path.substring('/temp/api/download/'.length), res);
            } else {
                fail(404, 'NotFound', 'no such temp API route');
            }
        } catch (err) {
            if (res.headersSent){
                res.destroy();
                return;
            }
            if (err instanceof TempError){
                this.render.renderJSON({ error: err.code, message: err.message }, res, err.status);
                return;
            }
            this.log('temp: unhandled error:', err && err.stack ? err.stack : err);
            this.render.renderJSON({ error: 'ServerError', message: 'the request could not be completed' }, res, 500);
        }
    }

    /** The caller's public key, from a cookie whose signature checks out. */
    session (ssid){
        const checked = ssid ? this.verifySsid(String(ssid)) : null;
        if (!checked || !checked.sValid){
            fail(401, 'Unauthorized', 'sign in to Northern first');
        }
        return checked.pubB64;
    }

    /**
     * A form on another site can post with the visitor's cookie attached, but
     * only as one of the simple content types, and a page there that fetches
     * names its own origin.
     */
    sameOrigin (req){
        if (SIMPLE.test(req.headers['content-type'] || '')){
            fail(415, 'UnsupportedMediaType', 'send the file as application/octet-stream');
        }
        const origin = req.headers.origin;
        if (origin && origin !== 'null'){
            let host;
            try {
                host = new URL(origin).host;
            } catch (e) {
                host = '';
            }
            if (host !== req.headers.host){
                fail(403, 'Forbidden', 'cross-origin requests are not accepted');
            }
        }
    }

    /**
     * Saves the request body under a new random id. Its size must be given up
     * front, so a file that does not fit is turned away before it is read.
     */
    async upload (req, ssid){
        this.session(ssid);
        this.sameOrigin(req);
        const declared = req.headers['content-length'];
        if (declared === undefined || !/^\d+$/.test(declared)){
            req.resume();
            fail(411, 'LengthRequired', 'say the file\'s size in Content-Length');
        }
        const size = Number(declared);
        if (size === 0){
            fail(400, 'BadRequest', 'the file is empty');
        }
        if (size > this.maxFile){
            req.resume();
            fail(413, 'TooLarge', `a file may be at most ${this.maxFile} bytes`);
        }
        try {
            await this.makeRoom(size);
        } catch (err) {
            req.resume();
            throw err;
        }

        const id = crypto.randomBytes(32).toString('base64url');
        const part = this.fileOf(id, false) + PART;
        try {
            let written = 0;
            const count = async function* (source){
                for await (const chunk of source){
                    written += chunk.length;
                    yield chunk;
                }
            };
            try {
                await pipeline(req, count, fs.createWriteStream(part, { flags: 'wx' }));
            } catch (err) {
                fail(400, 'BadRequest', 'the upload was cut short');
            }
            if (written !== size){
                fail(400, 'BadRequest', 'the upload was cut short');
            }
            await fs.promises.rename(part, this.fileOf(id, false));
        } catch (err) {
            await fs.promises.rm(part, { force: true });
            throw err;
        } finally {
            this.reserved -= size;
        }
        this.files.set(id, { size, at: this.now(), marked: false });
        await this.tidy();
        return { status: 'OK', id, size };
    }

    /**
     * Sends the file the id names, and marks it once it has all gone out. It
     * is opened before anything is sent, so a purge in between is a 404 and a
     * purge during is harmless.
     */
    async download (id, res){
        const entry = ID.test(id) ? this.files.get(id) : undefined;
        let handle;
        for (const marked of entry ? [entry.marked, !entry.marked] : []){
            try {
                handle = await fs.promises.open(this.fileOf(id, marked), 'r');
                break;
            } catch (err) {
                handle = undefined;
            }
        }
        if (!handle){
            fail(404, 'NotFound', 'no such file; it may have been purged');
        }
        let size;
        try {
            size = (await handle.stat()).size;
        } catch (err) {
            await handle.close();
            throw err;
        }
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': size,
            'Content-Disposition': 'attachment',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
        });
        res.on('finish', () => this.mark(id).then(() => this.tidy())
            .catch(err => this.log(`temp: could not purge: ${err.message}`)));
        // A client that goes away part way is no download: nothing is marked.
        await pipeline(handle.createReadStream(), res).catch(() => {});
    }
}
