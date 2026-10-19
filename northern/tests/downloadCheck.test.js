'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const FS_DIR = path.join(import.meta.dirname, '..', 'src', 'fs');
const HTML = fs.readFileSync(path.join(FS_DIR, 'reg', 'DownloadCheck.html'), 'utf8');
const OO = fs.readFileSync(path.join(FS_DIR, 'reg', 'oo.js'), 'utf8');

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const QUESTIONS = ['q_ios', 'q_model', 'q_location', 'q_icloud', 'q_power', 'q_data', 'q_lockdown', 'q_opened'];
const TESTS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

/** The inline <script> of the page; <script src=...> tags carry no body. */
function inlineScript(html) {
    return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n');
}

/** Throws as Chrome and Safari do when a host function is called detached from its object. */
function strict(owner, fn) {
    return function (...args) {
        if (this !== owner) {
            throw new TypeError('Illegal invocation');
        }
        return fn(...args);
    };
}

/**
 * Loads src/fs/reg/DownloadCheck.html into a vm with a DOM stub covering
 * what the page touches, the real oo.js and WebCrypto, recorded downloads and
 * share calls, and timers the test fires by hand.
 */
function loadPage({ userAgent = IPHONE, activation = { isActive: true, hasBeenActive: true }, share } = {}) {
    const elements = {};
    const downloads = [];
    const shared = [];
    const clipboard = [];
    const timers = [];
    const windowListeners = {};

    const element = (id, tag = 'div') => {
        if (!elements[id]) {
            const classes = new Set();
            const listeners = {};
            elements[id] = {
                id, tag, value: '', textContent: '', href: '', download: '', checked: id === 'warn',
                children: [],
                classList: { add: c => classes.add(c), contains: c => classes.has(c) },
                get className() { return [...classes].join(' '); },
                set className(v) { classes.clear(); v.split(' ').filter(Boolean).forEach(c => classes.add(c)); },
                getAttribute: name => (name === 'data-report' ? `report:${id}` : null),
                addEventListener: (event, fn) => { listeners[event] = fn; },
                appendChild(child) { this.children.push(child); },
                focus() {}, select() {}, setSelectionRange() {},
                fire: (event, arg) => listeners[event].call(elements[id], arg),
                click() { downloads.push({ name: this.download, href: this.href }); }
            };
        }
        return elements[id];
    };

    let created = 0;
    const document = {
        getElementById: id => element(id),
        querySelectorAll: selector => selector.split(',').map(s => s.trim()).flatMap(s =>
            s === '.question' ? QUESTIONS.map(id => element(id))
                : s === 'select.outcome' ? TESTS.map(t => element(`out_${t}`))
                    : s === '#warn' ? [element('warn')] : []),
        createElement: tag => element(`created${created++}`, tag),
        body: { appendChild() {}, removeChild() {} },
        addEventListener() {},
        visibilityState: 'visible'
    };

    const navigator = {
        userAgent,
        maxTouchPoints: 5,
        onLine: true,
        userActivation: activation,
        clipboard: {},
        storage: {}
    };
    navigator.clipboard.writeText = strict(navigator.clipboard, async text => { clipboard.push(text); });
    navigator.storage.estimate = strict(navigator.storage, async () => ({ usage: 1048576, quota: 1048576 * 500 }));
    navigator.canShare = strict(navigator, data => !!data.files);
    navigator.share = strict(navigator, share || (async data => { shared.push(data); }));

    class FileReader {
        readAsText(file) {
            this.result = file.text;
            queueMicrotask(() => this.onload());
        }
    }

    const sandbox = {
        document, navigator, FileReader, Blob, File, TextEncoder, TextDecoder, atob, btoa,
        crypto: globalThis.crypto,
        URL: { createObjectURL: blob => `blob:check/${blob.size}` },
        screen: { width: 390, height: 844 },
        devicePixelRatio: 3,
        isSecureContext: true,
        console: { log() {} },
        addEventListener: (event, fn) => { windowListeners[event] = fn; }
    };
    sandbox.setTimeout = strict(undefined, (fn, ms) => { timers.push({ fn, ms }); });
    sandbox.window = sandbox;

    const context = vm.createContext(sandbox);
    vm.runInContext(OO, context, { filename: 'oo.js' });
    vm.runInContext(inlineScript(HTML), context, { filename: 'DownloadCheck.html' });

    // Lets the async tests (encryption, share, file reads) finish.
    const settle = () => new Promise(resolve => setTimeout(resolve, 50));

    return {
        element, downloads, shared, clipboard, windowListeners,
        report: () => element('report').value,
        status: test => element(`st_${test}`).textContent,
        settle,
        /** Fires the timers the page has set so far, as if their time had come. */
        runTimers: () => timers.splice(0).forEach(t => t.fn()),
        timers
    };
}

/** The token a downloaded data: URL carries. */
const tokenOf = href => decodeURIComponent(href.split(',')[1]).match(/^token: (\w+)$/m)[1];

describe('DownloadCheck.html loads', () => {
    it('fills every outcome list and describes the browser', async () => {
        const page = loadPage();
        await page.settle();

        TESTS.forEach(t => assert.ok(page.element(`out_${t}`).children.length > 3, `outcomes for ${t}`));
        const report = page.report();
        assert.match(report, /Browser: Safari/);
        assert.match(report, /iOS \(as reported\): 17\.5/);
        assert.match(report, /Share sheet: files too/);
        assert.match(report, /Site storage: 1 MB used of 500 MB/);
        assert.match(report, /report:q_location: not checked/);
        assert.match(report, /page loaded/);
    });

    it('recognises a link opened inside another app', () => {
        const page = loadPage({ userAgent: IPHONE.replace(' Safari/604.1', ' Instagram 300.0') });
        assert.match(page.report(), /Browser: Instagram app/);
    });

    it('warns before leaving, like Reg.html, unless switched off', () => {
        const page = loadPage();
        let prevented = false;
        page.windowListeners.beforeunload({ preventDefault: () => { prevented = true; } });
        assert.ok(prevented);

        page.element('warn').checked = false;
        prevented = false;
        page.windowListeners.beforeunload({ preventDefault: () => { prevented = true; } });
        assert.ok(!prevented);
    });
});

describe('DownloadCheck.html tests', () => {
    it('A clicks a data: link the way Reg.html does', async () => {
        const page = loadPage();
        await page.element('run_A').fire('click');

        assert.strictEqual(page.downloads.length, 1);
        assert.match(page.downloads[0].name, /^northern-check\.A\.\d{8}T\d{6}\.txt$/);
        assert.match(page.downloads[0].href, /^data:application\/octet-stream,/);
        assert.match(page.status('A'), /still counts as your tap: yes/);
    });

    it('B encrypts with oo.js first and puts a * in the name; C does not', async () => {
        const page = loadPage();
        await page.element('run_B').fire('click');
        await page.element('run_C').fire('click');

        assert.strictEqual(page.downloads.length, 2);
        assert.match(page.downloads[0].name, /^northern-check\*\.B\./);
        assert.match(page.downloads[1].name, /^northern-check\.C\./);
        assert.match(page.status('B'), /after \d+ ms of encryption/);
    });

    it('D clicks only when its 3 s timer fires, and says when the tap has expired', async () => {
        const activation = { isActive: true, hasBeenActive: true };
        const page = loadPage({ activation });
        const running = page.element('run_D').fire('click');
        assert.strictEqual(page.downloads.length, 0);
        assert.strictEqual(page.timers.at(-1).ms, 3000);

        activation.isActive = false;
        page.runTimers();
        await running;

        assert.strictEqual(page.downloads.length, 1);
        assert.match(page.status('D'), /NO - expired/);
        assert.strictEqual(page.element('st_D').className, 'status bad');
    });

    it('E and F are real links, armed with a fresh file after each tap', () => {
        const page = loadPage();
        const e = page.element('run_E');
        const f = page.element('run_F');
        assert.match(e.href, /^data:/);
        assert.match(f.href, /^blob:/);
        assert.match(f.download, /^northern-check\.F\./);

        const first = tokenOf(e.href);
        e.fire('click');
        assert.match(page.status('E'), /tapped northern-check\.E\./);
        assert.strictEqual(tokenOf(e.href), first, 'the tapped file is left alone');
        page.runTimers();
        assert.notStrictEqual(tokenOf(e.href), first);
    });

    it('G hands the file to the share sheet', async () => {
        const page = loadPage();
        await page.element('run_G').fire('click');

        assert.strictEqual(page.shared.length, 1);
        assert.match(page.shared[0].files[0].name, /^northern-check\.G\./);
        assert.match(page.status('G'), /share sheet finished/);
    });

    it('G says so when the share sheet is closed', async () => {
        const page = loadPage({
            share: async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); }
        });
        await page.element('run_G').fire('click');
        assert.match(page.status('G'), /closed without saving/);
    });
});

describe('DownloadCheck.html reads files back from the phone', () => {
    it('marks the test whose file was found, and notices a rename', async () => {
        const page = loadPage();
        await page.element('run_A').fire('click');
        const text = decodeURIComponent(page.downloads[0].href.split(',')[1]);

        const input = page.element('verify');
        input.files = [
            { name: 'northern-check.A-1.txt', size: text.length, text },
            { name: 'holiday.jpg', size: 3, text: 'jpg' }
        ];
        input.fire('change');
        await page.settle();

        assert.ok(page.element('t_A').classList.contains('verified'));
        assert.strictEqual(page.element('out_A').value, 'saved');
        assert.match(page.status('A'), /FOUND on the phone.*saved as northern-check\.A-1\.txt/);
        assert.match(page.element('verify_status').textContent, /holiday\.jpg: not a download-check file/);
        assert.match(page.report(), /A\. Save Id Card, no passphrase: Saved - the file is in Files \[file found on phone\]/);
    });

    it('copies the report to the clipboard', async () => {
        const page = loadPage();
        page.element('q_location').value = 'iCloud Drive';
        await page.element('copy_report').fire('click');

        assert.strictEqual(page.clipboard.length, 1);
        assert.match(page.clipboard[0], /report:q_location: iCloud Drive/);
        assert.strictEqual(page.element('report_status').textContent, 'Copied.');
    });
});
