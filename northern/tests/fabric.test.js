'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fakeClock } from './helpers/ramaPage.js';

const PWA_DIR = path.join(import.meta.dirname, '..', 'src', 'fs', 'pwa', 'fabric');
const read = name => fs.readFileSync(path.join(PWA_DIR, name), 'utf8');

// As long as the peel in fabric.js (PEEL_MS).
const PEEL_MS = 650;

/**
 * Fabric as the page uses it: objects, a selection of many, the canvas and its
 * brushes. The real one needs a browser; this one remembers what was done.
 */
function fakeFabric(element, retina = 1) {
    class Obj {
        constructor(options = {}) { Object.assign(this, { type: 'object', left: 0, top: 0, scaleX: 1, scaleY: 1 }, options); }
        set(key, value) { Object.assign(this, typeof key === 'string' ? { [key]: value } : key); return this; }
        setCoords() {}
        clone(callback) { callback(new this.constructor({ ...this })); }
        // What it covers on the canvas: as wide and tall as it is shown.
        getBoundingRect() {
            return { left: this.left, top: this.top, width: (this.width || 0) * Math.abs(this.scaleX || 1), height: (this.height || 0) * Math.abs(this.scaleY || 1) };
        }
        // The object drawn alone: a picture `multiplier` times its size, or none when too big for a canvas.
        toCanvasElement(options) {
            const bounds = Obj.prototype.getBoundingRect.call(this);
            // A canvas drops the fraction of a width it is given.
            // Cropped, when told so, as fabric does.
            const [width, height] = options.width ? [options.width, options.height] : [bounds.width, bounds.height];
            const picture = { options, width: Math.floor(width * options.multiplier + 1e-9), height: Math.floor(height * options.multiplier + 1e-9) };
            picture.toBlob = (callback, type) => callback(this.tooBig ? null : { type, picture });
            return picture;
        }
    }
    class ActiveSelection extends Obj {
        constructor(objects, options = {}) { super({ ...options, type: 'activeSelection' }); this.objects = objects; }
        forEachObject(fn) { this.objects.forEach(fn); }
        clone(callback) {
            const copies = this.objects.map(o => { let copy; o.clone(c => { copy = c; }); return copy; });
            callback(new ActiveSelection(copies, { left: this.left, top: this.top }));
        }
    }
    class Brush { constructor(canvas) { this.canvas = canvas; this.kind = this.constructor.name; } }
    class Canvas {
        constructor(id, options) {
            const el = element(id);
            Object.assign(this, { isDrawingMode: options.isDrawingMode, width: el.width, height: el.height });
            Object.assign(this, { objects: [], active: null, listeners: {}, offsets: 0, cleared: 0 });
            this.freeDrawingBrush = new fabric.PencilBrush(this);
            Object.assign(this, { selection: true, skipTargetFind: false, defaultCursor: 'default', snapshots: [] });
        }
        on(event, fn) { (this.listeners[event] = this.listeners[event] || []).push(fn); }
        fire(event, data) { (this.listeners[event] || []).forEach(fn => fn(data)); }
        // A pointer event here is the point itself.
        getPointer(e) { return { x: e.x, y: e.y }; }
        getRetinaScaling() { return retina; }
        getActiveObject() { return this.active; }
        getActiveObjects() {
            if (!this.active) return [];
            return this.active.type === 'activeSelection' ? this.active.objects.slice() : [this.active];
        }
        setActiveObject(obj) { this.active = obj; this.fire('selection:created'); }
        discardActiveObject() { if (this.active) { this.active = null; this.fire('selection:cleared'); } }
        add(...objects) { this.objects.push(...objects); }
        remove(...objects) { this.objects = this.objects.filter(o => !objects.includes(o)); }
        clear() { this.objects = []; this.active = null; this.cleared += 1; }
        requestRenderAll() {}
        getWidth() { return this.width; }
        getHeight() { return this.height; }
        setDimensions({ width, height }) { this.width = width; this.height = height; }
        calcOffset() { this.offsets += 1; }
        toDataURL(options) {
            // What is on the canvas as it is taken: a dashed frame would show in it.
            this.snapshots.push({ ...options, objects: this.objects.map(o => o.name || o.type) });
            return 'data:image/' + options.format + ';base64,AAAA';
        }
        toJSON(kept = []) { return { objects: this.objects.map(o => o.name), kept }; }
        loadFromJSON(json, callback) { this.loaded = json; callback(); }
    }
    const fabric = {
        Object: Obj, ActiveSelection, Canvas,
        PencilBrush: class PencilBrush extends Brush {},
        CircleBrush: class CircleBrush extends Brush {},
        SprayBrush: class SprayBrush extends Brush {},
        PatternBrush: class PatternBrush extends Brush {},
        Shadow: class Shadow { constructor(options) { Object.assign(this, options); } },
        Rect: class Rect extends Obj {
            constructor(options) { super({ ...options, type: 'rect' }); }
            getBoundingRect() { return { width: 14 }; }
            render() {}
        },
        Circle: class Circle extends Obj { constructor(options) { super({ ...options, type: 'circle' }); } },
        Line: class Line extends Obj {
            constructor([x1, y1, x2, y2], options) { super({ ...options, type: 'line', x1, y1, x2, y2 }); }
        },
        Text: class Text extends Obj { constructor(text, options) { super({ ...options, type: 'text' }); this.text = text; } },
        Textbox: class Textbox extends Obj { constructor(text, options) { super({ ...options, type: 'textbox' }); this.text = text; } },
        Group: class Group extends Obj {
            constructor(objects, options) { super({ ...options, type: 'group' }); this.objects = objects; }
            getObjects() { return this.objects; }
        },
        Image: class Image extends Obj {
            constructor(options) { super({ ...options, type: 'image' }); }
            scaleToHeight(height) { this.height = height; }
            static fromURL(src, callback) { callback(new this({ src })); }
        },
        document: { createElement: () => ({ getContext: () => ({}) }) }
    };
    return fabric;
}

/** The elements of index.html by id, with the attributes their tags have. */
function stubElements(html) {
    const elements = {};
    const tags = new Map([...html.matchAll(/<[a-z]+\b[^>]*\bid="([^"]+)"[^>]*>/g)].map(m => [m[1], m[0]]));
    function element(id) {
        if (!tags.has(id)) return null;
        if (!elements[id]) {
            const tag = tags.get(id);
            const attributes = Object.fromEntries([...tag.matchAll(/\s([a-z-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
            const classes = new Set((attributes.class || '').split(/\s+/).filter(Boolean));
            // A select has its options, and the first one chosen.
            const select = new RegExp(`<select[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</select>`).exec(html);
            const options = select ? [...select[1].matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)]
                .map(m => ({ value: m[1].replace(/&#39;/g, "'"), textContent: m[2] })) : null;
            elements[id] = {
                id, attributes, listeners: {}, focused: 0, textContent: '', files: [],
                value: attributes.value || (options ? options[0].value : ''), options, style: {},
                get selectedIndex() { return this.options.findIndex(o => o.value === this.value); },
                inert: /\sinert[\s>]/.test(tag), checked: /\schecked[\s>]/.test(tag), disabled: false,
                classList: {
                    add: (...names) => names.forEach(n => classes.add(n)),
                    remove: (...names) => names.forEach(n => classes.delete(n)),
                    contains: name => classes.has(name)
                },
                addEventListener(event, fn) { (this.listeners[event] = this.listeners[event] || []).push(fn); },
                fire(event, data = {}) { (this.listeners[event] || []).forEach(fn => fn.call(this, data)); },
                setAttribute(name, value) { this.attributes[name] = String(value); },
                getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; },
                focus() { this.focused += 1; }
            };
        }
        return elements[id];
    }
    element.withCommand = () => [...tags.keys()].map(element).filter(el => el.attributes['data-command']);
    return element;
}

/** The real page - index.html's elements, fabric.js - in a sandbox with fabric faked and a clock the test moves. */
function mountFabric({ width = 800, height = 600, confirm = true, retina = 1 } = {}) {
    const html = read('index.html');
    const element = stubElements(html);
    const clock = fakeClock(Date.UTC(2026, 9, 7, 9, 0));
    const fabric = fakeFabric(element, retina);
    const asked = [];
    const saved = [];
    const URL = {
        made: [], revoked: [],
        createObjectURL(blob) { this.made.push(blob); return 'blob:' + this.made.length; },
        revokeObjectURL(url) { this.revoked.push(url); }
    };
    const document = {
        // The link a download is clicked on.
        createElement(tag) {
            assert.strictEqual(tag, 'a');
            const link = { href: '', download: '', click() { saved.push({ href: this.href, download: this.download, attached: this.attached }); }, remove() { this.attached = false; } };
            return link;
        },
        body: { appendChild(link) { link.attached = true; } },
        getElementById: element,
        querySelectorAll: selector => { assert.strictEqual(selector, '[data-command]'); return element.withCommand(); }
    };
    const window = {
        innerWidth: width, innerHeight: height, listeners: {},
        addEventListener(event, fn) { this.listeners[event] = fn; },
        confirm: text => { asked.push(text); return confirm; },
        scrolledTo: [], scrollTo(x, y) { this.scrolledTo.push([x, y]); }
    };
    class FileReader {
        constructor() { this.listeners = {}; FileReader.last = this; }
        addEventListener(event, fn) { this.listeners[event] = fn; }
        readAsText(file) { this.result = file.text; this.listeners.load(); }
        readAsDataURL(file) { this.result = 'data:image/png;base64,' + file.text; this.listeners.load(); }
    }
    class Image { constructor() { Image.made.push(this); } }
    Image.made = [];
    const sandbox = {
        console, document, window, fabric, FileReader, URL, Image, JSON, Math, Date: clock.Date, encodeURIComponent,
        setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout
    };
    // What the page puts on window is global, as in a browser.
    Object.setPrototypeOf(window, sandbox);
    sandbox.window = window;
    vm.runInContext(read('fabric.js'), vm.createContext(sandbox), { filename: 'fabric.js' });

    const canvas = window.__canvas;
    const page = {
        element, clock, canvas, window, asked, Image, FileReader, URL, saved, fabric,
        click: id => element(id).fire('click'),
        front: () => (element('page_draw').classList.contains('front') ? 'draw' : '') +
            (element('page_controls').classList.contains('front') ? 'controls' : ''),
        /** Peels the top page off, and waits for it to come off. */
        peel: () => { page.click(page.front() === 'draw' ? 'peel_top' : 'peel_back'); clock.advance(PEEL_MS); },
        /** Objects on the canvas, as a user would draw them. */
        draw: (...names) => names.map(name => { const o = new fabric.Object({ name }); canvas.add(o); return o; }),
        /** What a user picks on the canvas: one object, or a selection of many. */
        select: (...objects) => canvas.setActiveObject(objects.length === 1 ? objects[0] : new fabric.ActiveSelection(objects)),
        names: () => canvas.objects.map(o => o.name),
        slide: (id, value) => { element(id).value = String(value); element(id).fire('input'); },
        load: (id, text) => { element(id).files = [{ text }]; element(id).fire('change'); },
        status: () => element('status').textContent,
        /** A drag on the drawing, from one point to another, by way of the ones between. */
        drag: (...points) => {
            canvas.fire('mouse:down', { e: points[0] });
            points.slice(1).forEach(e => canvas.fire('mouse:move', { e }));
            canvas.fire('mouse:up', { e: {} });
        }
    };
    return page;
}

describe('Fabric: the two pages', () => {
    it('starts with the drawing on top and the controls under it', () => {
        const page = mountFabric();
        assert.strictEqual(page.front(), 'draw');
        assert.strictEqual(page.element('page_controls').inert, true);
        assert.strictEqual(page.canvas.isDrawingMode, true);
        assert.deepStrictEqual([page.canvas.width, page.canvas.height], [800, 600]);
    });

    it('peels the drawing off to the controls, and back again', () => {
        const page = mountFabric();
        page.click('peel_top');
        assert.ok(page.element('page_draw').classList.contains('peeling'));
        assert.strictEqual(page.element('page_controls').inert, false, 'live while the top one lifts');
        assert.strictEqual(page.front(), 'draw');

        page.clock.advance(PEEL_MS);
        assert.strictEqual(page.front(), 'controls');
        assert.ok(!page.element('page_draw').classList.contains('peeling'));
        assert.strictEqual(page.element('page_draw').inert, true);
        assert.strictEqual(page.element('peel_back').focused, 1);

        page.peel();
        assert.strictEqual(page.front(), 'draw');
        assert.strictEqual(page.element('page_controls').inert, true);
        assert.strictEqual(page.element('peel_top').focused, 1);
    });

    it('ignores the corner while a page is still coming off', () => {
        const page = mountFabric();
        page.click('peel_top');
        page.click('peel_top');
        page.click('peel_back');
        page.clock.advance(PEEL_MS);
        assert.strictEqual(page.front(), 'controls');
    });

    it('keeps the selection on the canvas as it peels, both ways', () => {
        const page = mountFabric();
        const [a, b] = page.draw('a', 'b', 'c');
        page.select(a, b);
        page.peel();
        assert.deepStrictEqual(page.canvas.getActiveObjects(), [a, b]);
        assert.strictEqual(page.element('selected').textContent, '2 objects selected');
        assert.strictEqual(page.element('copy-el').disabled, false);
        assert.strictEqual(page.element('remove-el').disabled, false);
        assert.strictEqual(page.element('paste-el').disabled, true, 'nothing copied yet');

        page.peel();
        assert.deepStrictEqual(page.canvas.getActiveObjects(), [a, b]);
    });

    it('says when nothing is selected, and Copy and Remove are off', () => {
        const page = mountFabric();
        page.draw('a');
        page.peel();
        assert.strictEqual(page.element('selected').textContent, 'Nothing selected');
        assert.strictEqual(page.element('copy-el').disabled, true);
        assert.strictEqual(page.element('remove-el').disabled, true);
    });

    it('brings the controls back at their top, header and corner in sight, after a file picker scrolled them', () => {
        const page = mountFabric({ height: 400 });
        const controls = page.element('page_controls');
        page.peel();
        // A phone scrolls the page itself to show the file input as its picker opens.
        controls.scrollTop = 520;
        page.load('fileinput', 'PNGDATA');
        assert.strictEqual(controls.scrollTop, 0);

        controls.scrollTop = 520;
        page.element('jsoninput').fire('cancel');
        assert.strictEqual(controls.scrollTop, 0, 'a picker closed without a file too');

        controls.scrollTop = 520;
        page.peel();
        page.peel();
        assert.strictEqual(controls.scrollTop, 0, 'and every time the controls come to the front');
        assert.deepStrictEqual(page.window.scrolledTo.at(-1), [0, 0]);
    });

    it('lets only the list of controls scroll: the file inputs are in it, and no page scrolls', () => {
        const css = read('styles.css');
        const rule = selector => new RegExp(`(^|\\n)${selector.replace(/[.*]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)[2];
        assert.match(rule('.page'), /overflow: clip;/);
        assert.match(rule('.group'), /position: relative;/);
        assert.match(rule('input.file'), /top: 0;[\s\S]*left: 0;/);
        // Every file input is in a group of controls, so it scrolls with the list.
        const html = read('index.html');
        const files = html.match(/<input class="file"/g).length;
        const inGroups = [...html.matchAll(/<section class="group">([\s\S]*?)<\/section>/g)]
            .reduce((n, m) => n + (m[1].match(/<input class="file"/g) || []).length, 0);
        assert.strictEqual(inGroups, files);
    });

    it('fits the canvas to the window while the drawing is on top, not while the controls are', () => {
        const page = mountFabric();
        page.peel();
        page.window.innerHeight = 300; // a keyboard came up under the text box
        page.window.listeners.resize();
        assert.strictEqual(page.canvas.height, 600);

        page.window.innerHeight = 700;
        page.peel();
        assert.strictEqual(page.canvas.height, 700);
        page.window.innerWidth = 1000;
        page.window.listeners.resize();
        assert.strictEqual(page.canvas.width, 1000);
    });
});

describe('Fabric: the selection', () => {
    it('removes every selected object, not only one', () => {
        const page = mountFabric();
        const [a, , c, d] = page.draw('a', 'b', 'c', 'd');
        page.select(a, c, d);
        page.peel();
        page.click('remove-el');
        assert.deepStrictEqual(page.names(), ['b']);
        assert.strictEqual(page.canvas.getActiveObject(), null);
        assert.strictEqual(page.status(), 'Removed 3 objects.');
        assert.strictEqual(page.element('selected').textContent, 'Nothing selected');
        assert.strictEqual(page.element('remove-el').disabled, true);
    });

    it('removes the one selected object', () => {
        const page = mountFabric();
        const [, b] = page.draw('a', 'b');
        page.select(b);
        page.click('remove-el');
        assert.deepStrictEqual(page.names(), ['a']);
        assert.strictEqual(page.status(), 'Removed 1 object.');
    });

    it('copies what was selected on the drawing, and pastes it again and again', () => {
        const page = mountFabric();
        const [a, b] = page.draw('a', 'b');
        a.set({ left: 100, top: 100 });
        page.select(a, b);
        page.peel();
        page.click('copy-el');
        assert.strictEqual(page.status(), 'Copied 2 objects.');
        assert.strictEqual(page.element('paste-el').disabled, false);

        page.click('paste-el');
        assert.deepStrictEqual(page.names(), ['a', 'b', 'a', 'b']);
        assert.deepStrictEqual(page.canvas.getActiveObjects(), page.canvas.objects.slice(2), 'the copies are selected');
        page.click('paste-el');
        assert.deepStrictEqual(page.names(), ['a', 'b', 'a', 'b', 'a', 'b']);
    });

    it('says so when there is nothing to copy or paste', () => {
        const page = mountFabric();
        page.click('copy-el');
        assert.strictEqual(page.status(), 'Nothing selected to copy.');
        page.click('paste-el');
        assert.strictEqual(page.status(), 'Nothing copied to paste.');
        page.click('remove-el');
        assert.strictEqual(page.status(), 'Nothing selected to remove.');
        page.clock.advance(4000);
        assert.strictEqual(page.status(), '');
    });

    it('clears the drawing only when the user says yes', () => {
        const no = mountFabric({ confirm: false });
        no.draw('a');
        no.click('clear-canvas');
        assert.deepStrictEqual(no.names(), ['a']);
        assert.strictEqual(no.asked.length, 1);

        const yes = mountFabric();
        yes.draw('a');
        yes.click('clear-canvas');
        assert.deepStrictEqual(yes.names(), []);
    });

    it('turns drawing mode off, so objects can be picked, and on again', () => {
        const page = mountFabric();
        page.click('drawing-mode');
        assert.strictEqual(page.canvas.isDrawingMode, false);
        assert.strictEqual(page.element('drawing-mode').getAttribute('aria-pressed'), 'false');
        page.click('drawing-mode');
        assert.strictEqual(page.canvas.isDrawingMode, true);
        assert.strictEqual(page.element('drawing-mode').getAttribute('aria-pressed'), 'true');
    });
});

describe('Fabric: an area', () => {
    it('brings the drawing to drag on, with nothing on it to move or draw', () => {
        const page = mountFabric();
        const [a] = page.draw('a');
        page.select(a);
        page.peel();
        page.click('area-el');
        assert.strictEqual(page.status(), 'Drag over the part to copy.');
        page.clock.advance(PEEL_MS);
        assert.strictEqual(page.front(), 'draw');
        assert.strictEqual(page.canvas.isDrawingMode, false);
        assert.strictEqual(page.canvas.selection, false);
        assert.strictEqual(page.canvas.skipTargetFind, true, 'a drag on an object does not move it');
        assert.strictEqual(page.canvas.getActiveObject(), null);
    });

    it('copies all that is in the area dragged as one new image, and Paste adds it', () => {
        const page = mountFabric();
        page.draw('photo', 'line');
        page.peel();
        page.click('area-el');
        page.clock.advance(PEEL_MS);
        // Up and to the left: the area is the same.
        page.drag({ x: 300, y: 250 }, { x: 200, y: 200 }, { x: 100.4, y: 50.6 });

        const [shot] = page.canvas.snapshots;
        assert.deepStrictEqual([shot.left, shot.top, shot.width, shot.height], [100, 51, 200, 199]);
        assert.strictEqual(shot.format, 'png');
        assert.strictEqual(shot.enableRetinaScaling, true);
        assert.deepStrictEqual(shot.objects, ['photo', 'line'], 'without the dashed frame');
        assert.deepStrictEqual(page.names(), ['photo', 'line'], 'the frame is gone');
        assert.strictEqual(page.status(), 'Area copied: Paste adds it as a new image.');

        // The drawing as it was.
        assert.strictEqual(page.canvas.isDrawingMode, true);
        assert.strictEqual(page.canvas.selection, true);
        assert.strictEqual(page.canvas.skipTargetFind, false);
        assert.strictEqual(page.canvas.defaultCursor, 'default');

        page.peel();
        assert.strictEqual(page.element('paste-el').disabled, false);
        page.click('paste-el');
        const pasted = page.canvas.objects.at(-1);
        assert.strictEqual(pasted.type, 'image');
        assert.strictEqual(pasted.src, 'data:image/png;base64,AAAA');
        assert.deepStrictEqual([pasted.left, pasted.top], [110, 61], 'a little off where it was taken');
        assert.strictEqual(page.canvas.getActiveObject(), pasted);
    });

    it('shows the area as it is dragged, inside the canvas', () => {
        const page = mountFabric();
        page.click('area-el');
        page.canvas.fire('mouse:down', { e: { x: 700, y: 500 } });
        page.canvas.fire('mouse:move', { e: { x: 900, y: -20 } });
        const frame = page.canvas.objects.at(-1);
        assert.deepStrictEqual([frame.left, frame.top, frame.width, frame.height], [700, 0, 100, 500]);
        assert.strictEqual(frame.excludeFromExport, true, 'not in a drawing downloaded as JSON');
        assert.deepStrictEqual(page.canvas.snapshots, []);
    });

    it('takes the copy as sharp as the screen, and shows it the size it was', () => {
        const page = mountFabric({ retina: 2 });
        page.click('area-el');
        page.drag({ x: 10, y: 10 }, { x: 110, y: 60 });
        page.click('paste-el');
        const pasted = page.canvas.objects.at(-1);
        assert.deepStrictEqual([pasted.scaleX, pasted.scaleY], [0.5, 0.5]);
    });

    it('copies nothing for a tap, and says so', () => {
        const page = mountFabric();
        page.click('area-el');
        page.drag({ x: 100, y: 100 });
        assert.deepStrictEqual(page.canvas.snapshots, []);
        assert.strictEqual(page.status(), 'Too small to copy: Select area again, and drag over the part.');
        assert.strictEqual(page.element('paste-el').disabled, true);
        assert.strictEqual(page.canvas.isDrawingMode, true, 'the drawing as it was');
    });

    it('lets an area not dragged go when the controls come back', () => {
        const page = mountFabric();
        page.click('drawing-mode');
        page.click('area-el');
        page.clock.advance(PEEL_MS);
        page.peel();
        assert.strictEqual(page.canvas.skipTargetFind, false);
        assert.strictEqual(page.canvas.isDrawingMode, false, 'drawing mode as the user left it');
        page.peel();
        page.drag({ x: 0, y: 0 }, { x: 50, y: 50 });
        assert.deepStrictEqual(page.canvas.snapshots, [], 'a drag after is a drag, not an area');
    });
});

describe('Fabric: a straight line', () => {
    /** The page with the straight line picked in Mode. */
    function straight(options) {
        const page = mountFabric(options);
        const mode = page.element('drawing-mode-selector');
        mode.value = 'straight';
        mode.fire('change');
        return page;
    }
    const ends = line => [line.x1, line.y1, line.x2, line.y2];

    it('draws with fabric\'s drawing mode off, and nothing to pick or move as it is dragged', () => {
        const page = straight();
        assert.strictEqual(page.canvas.isDrawingMode, false);
        assert.strictEqual(page.canvas.selection, false);
        assert.strictEqual(page.canvas.skipTargetFind, true);
        assert.strictEqual(page.canvas.defaultCursor, 'crosshair');
        assert.strictEqual(page.element('drawing-mode').getAttribute('aria-pressed'), 'true', 'drawing mode is on');
    });

    it('draws across when the drag goes more across than down', () => {
        const page = straight();
        page.drag({ x: 100, y: 100 }, { x: 300, y: 130 });
        const [line] = page.canvas.objects;
        assert.strictEqual(line.type, 'line');
        assert.deepStrictEqual(ends(line), [100, 100, 300, 100]);
    });

    it('draws down when the drag goes more down than across, and turns as the drag does', () => {
        const page = straight();
        page.canvas.fire('mouse:down', { e: { x: 100, y: 100 } });
        page.canvas.fire('mouse:move', { e: { x: 250, y: 120 } });
        const [line] = page.canvas.objects;
        assert.deepStrictEqual(ends(line), [100, 100, 250, 100], 'across, so far');
        page.canvas.fire('mouse:move', { e: { x: 80, y: -40 } });
        assert.deepStrictEqual(ends(line), [100, 100, 100, -40], 'now up');
        page.canvas.fire('mouse:up', { e: {} });
        assert.deepStrictEqual(ends(line), [100, 100, 100, -40]);
        assert.strictEqual(page.canvas.objects.length, 1);
    });

    it('draws in the brush\'s color, width and shadow, round at the ends', () => {
        const page = straight();
        page.slide('drawing-line-width', 12);
        page.slide('drawing-shadow-width', 3);
        page.slide('drawing-shadow-offset', 2);
        page.element('drawing-color').value = '#aa0000';
        page.element('drawing-shadow-color').value = '#00aa00';
        page.drag({ x: 0, y: 0 }, { x: 40, y: 0 });
        const [line] = page.canvas.objects;
        assert.strictEqual(line.stroke, '#aa0000');
        assert.strictEqual(line.strokeWidth, 12);
        assert.strictEqual(line.strokeLineCap, 'round');
        assert.deepStrictEqual([line.shadow.blur, line.shadow.offsetX, line.shadow.offsetY, line.shadow.color], [3, 2, 2, '#00aa00']);
    });

    it('draws nothing for a tap', () => {
        const page = straight();
        page.drag({ x: 100, y: 100 }, { x: 102, y: 101 });
        assert.deepStrictEqual(page.canvas.objects, []);
    });

    it('draws nothing with drawing mode off: objects can be picked then', () => {
        const page = straight();
        page.click('drawing-mode');
        assert.strictEqual(page.canvas.isDrawingMode, false);
        assert.strictEqual(page.canvas.selection, true);
        assert.strictEqual(page.canvas.skipTargetFind, false);
        page.drag({ x: 0, y: 0 }, { x: 50, y: 0 });
        assert.deepStrictEqual(page.canvas.objects, []);

        page.click('drawing-mode');
        page.drag({ x: 0, y: 0 }, { x: 50, y: 0 });
        assert.strictEqual(page.canvas.objects.length, 1);
    });

    it('keeps the brush for when another mode is picked', () => {
        const page = straight();
        const mode = page.element('drawing-mode-selector');
        mode.value = 'Spray';
        mode.fire('change');
        assert.strictEqual(page.canvas.freeDrawingBrush.kind, 'SprayBrush');
        assert.strictEqual(page.canvas.isDrawingMode, true);
        assert.strictEqual(page.canvas.skipTargetFind, false);
        page.drag({ x: 0, y: 0 }, { x: 50, y: 0 });
        assert.deepStrictEqual(page.canvas.objects, [], 'the brush draws, not the line tool');
    });

    it('lets Select area have the drag, and comes back after it', () => {
        const page = straight();
        page.click('area-el');
        page.drag({ x: 10, y: 10 }, { x: 110, y: 60 });
        assert.strictEqual(page.canvas.snapshots.length, 1);
        assert.deepStrictEqual(page.canvas.objects, [], 'no line from the area\'s drag');
        assert.strictEqual(page.canvas.skipTargetFind, true, 'the straight line again');
        page.drag({ x: 0, y: 0 }, { x: 0, y: 50 });
        assert.deepStrictEqual(ends(page.canvas.objects[0]), [0, 0, 0, 50]);
    });

    it('stops for a textbox, which needs drawing mode off', () => {
        const page = straight();
        page.click('add-textbox');
        assert.strictEqual(page.element('drawing-mode').getAttribute('aria-pressed'), 'false');
        page.drag({ x: 0, y: 0 }, { x: 50, y: 0 });
        assert.strictEqual(page.canvas.objects.length, 1, 'only the textbox');
    });
});

describe('Fabric: a rectangle and a circle', () => {
    /** The page with a shape picked in Mode. */
    function shape(name) {
        const page = mountFabric();
        const mode = page.element('drawing-mode-selector');
        mode.value = name;
        mode.fire('change');
        return page;
    }
    const box = o => [o.left, o.top, o.width, o.height];

    it('lists the shapes apart from the brushes, and the dots brush as Dots', () => {
        const html = read('index.html');
        const shapes = /<optgroup label="Shapes">([\s\S]*?)<\/optgroup>/.exec(html)[1];
        assert.deepStrictEqual([...shapes.matchAll(/value="([^"]+)"/g)].map(m => m[1]), ['straight', 'rectangle', 'circle']);
        assert.match(html, /<option value="Circle">Dots<\/option>/);

        const page = shape('Circle');
        assert.strictEqual(page.canvas.freeDrawingBrush.kind, 'CircleBrush');
        assert.strictEqual(page.canvas.isDrawingMode, true);
    });

    it('draws a rectangle from corner to corner, whichever way the drag goes', () => {
        const page = shape('rectangle');
        assert.strictEqual(page.canvas.isDrawingMode, false);
        assert.strictEqual(page.canvas.skipTargetFind, true);

        page.drag({ x: 100, y: 100 }, { x: 300, y: 180 });
        page.drag({ x: 500, y: 400 }, { x: 420, y: 250 });
        const [down, up] = page.canvas.objects;
        assert.deepStrictEqual(box(down), [100, 100, 200, 80]);
        assert.deepStrictEqual(box(up), [420, 250, 80, 150], 'up and to the left');
    });

    it('draws a circle in the square from where the drag started, as wide as it went furthest', () => {
        const page = shape('circle');
        page.canvas.fire('mouse:down', { e: { x: 100, y: 100 } });
        page.canvas.fire('mouse:move', { e: { x: 160, y: 120 } });
        const [circle] = page.canvas.objects;
        assert.deepStrictEqual([circle.left, circle.top, circle.radius], [100, 100, 30], 'as it is dragged');

        page.canvas.fire('mouse:move', { e: { x: 20, y: 60 } });
        page.canvas.fire('mouse:up', { e: {} });
        assert.deepStrictEqual([circle.left, circle.top, circle.radius], [20, 20, 40], 'up and to the left');
        assert.strictEqual(page.canvas.objects.length, 1);
    });

    it('draws only the outline, in the brush\'s color, width and shadow, as wide when resized', () => {
        for (const name of ['rectangle', 'circle']) {
            const page = shape(name);
            page.slide('drawing-line-width', 6);
            page.slide('drawing-shadow-width', 4);
            page.element('drawing-color').value = '#0000aa';
            page.drag({ x: 0, y: 0 }, { x: 60, y: 60 });
            const [drawn] = page.canvas.objects;
            assert.strictEqual(drawn.fill, 'transparent', name);
            assert.strictEqual(drawn.stroke, '#0000aa', name);
            assert.strictEqual(drawn.strokeWidth, 6, name);
            assert.strictEqual(drawn.strokeUniform, true, name);
            assert.strictEqual(drawn.shadow.blur, 4, name);
        }
    });

    it('draws nothing for a tap', () => {
        for (const name of ['rectangle', 'circle']) {
            const page = shape(name);
            page.drag({ x: 100, y: 100 }, { x: 102, y: 103 });
            assert.deepStrictEqual(page.canvas.objects, [], name);
        }
    });

    it('draws the shape picked last', () => {
        const page = shape('rectangle');
        page.drag({ x: 0, y: 0 }, { x: 50, y: 50 });
        const mode = page.element('drawing-mode-selector');
        mode.value = 'circle';
        mode.fire('change');
        page.drag({ x: 0, y: 0 }, { x: 50, y: 50 });
        mode.value = 'straight';
        mode.fire('change');
        page.drag({ x: 0, y: 0 }, { x: 50, y: 10 });
        assert.deepStrictEqual(page.canvas.objects.map(o => o.constructor.name), ['Rect', 'Circle', 'Line']);
    });
});

describe('Fabric: the fill of a shape', () => {
    function shape(name) {
        const page = mountFabric();
        const mode = page.element('drawing-mode-selector');
        mode.value = name;
        mode.fire('change');
        return page;
    }
    const fill = (page, on) => { page.element('shape-fill').checked = on; page.element('shape-fill').fire('change'); };
    const color = (page, value) => { page.element('shape-fill-color').value = value; page.element('shape-fill-color').fire('input'); };

    it('fills new rectangles and circles in the fill color, with Fill on', () => {
        for (const name of ['rectangle', 'circle']) {
            const page = shape(name);
            assert.strictEqual(page.element('shape-fill').checked, false, 'off at first');
            page.drag({ x: 0, y: 0 }, { x: 60, y: 60 });
            fill(page, true);
            assert.strictEqual(page.status(), 'Fill on for new shapes.');
            page.drag({ x: 100, y: 100 }, { x: 160, y: 160 });
            const [plain, filled] = page.canvas.objects;
            assert.strictEqual(plain.fill, 'transparent', name);
            assert.strictEqual(filled.fill, '#9fd3e0', name);
            assert.strictEqual(filled.stroke, '#005E7A', 'the outline as before');
        }
    });

    it('turns Fill on when a fill color is picked', () => {
        const page = shape('rectangle');
        color(page, '#ff8800');
        assert.strictEqual(page.element('shape-fill').checked, true);
        page.drag({ x: 0, y: 0 }, { x: 60, y: 60 });
        assert.strictEqual(page.canvas.objects[0].fill, '#ff8800');
    });

    it('fills no straight line', () => {
        const page = shape('straight');
        fill(page, true);
        page.drag({ x: 0, y: 0 }, { x: 60, y: 0 });
        assert.strictEqual(page.canvas.objects[0].fill, undefined);
    });

    it('fills the selected rectangles and circles, and nothing else selected', () => {
        const page = shape('rectangle');
        page.drag({ x: 0, y: 0 }, { x: 60, y: 60 });
        const mode = page.element('drawing-mode-selector');
        mode.value = 'circle';
        mode.fire('change');
        page.drag({ x: 100, y: 100 }, { x: 160, y: 160 });
        const [rect, circle] = page.canvas.objects;
        const [other] = page.draw('stroke');
        page.select(rect, circle, other);
        page.peel();

        color(page, '#336699');
        assert.deepStrictEqual([rect.fill, circle.fill, other.fill], ['#336699', '#336699', undefined]);
        assert.strictEqual(page.status(), 'Fill on for 2 shapes.');
        fill(page, false);
        assert.deepStrictEqual([rect.fill, circle.fill], ['transparent', 'transparent']);
        assert.strictEqual(page.status(), 'Fill off for 2 shapes.');
    });

    it('shows the fill of the selected shape', () => {
        const page = shape('rectangle');
        color(page, '#aabbcc');
        page.drag({ x: 0, y: 0 }, { x: 60, y: 60 });
        fill(page, false);
        page.select(page.canvas.objects[0]);
        page.peel();
        assert.strictEqual(page.element('shape-fill').checked, true);
        assert.strictEqual(page.element('shape-fill-color').value, '#aabbcc');

        page.canvas.objects[0].set('fill', 'transparent');
        page.peel();
        page.peel();
        assert.strictEqual(page.element('shape-fill').checked, false);
        assert.strictEqual(page.element('shape-fill-color').value, '#aabbcc', 'the color kept for when Fill is on again');
    });
});

describe('Fabric: Download selected', () => {
    const image = (page, options) => { const img = new page.fabric.Image({ name: 'photo', ...options }); page.canvas.add(img); return img; };

    it('is off with nothing selected', () => {
        const page = mountFabric();
        page.draw('a');
        page.peel();
        assert.strictEqual(page.element('down-selected').disabled, true);
        page.click('down-selected');
        assert.strictEqual(page.status(), 'Nothing selected to download.');
        assert.deepStrictEqual(page.saved, []);
    });

    it('saves one image at its own resolution, not as shrunk to the screen', () => {
        const page = mountFabric({ retina: 2 });
        // A 4000 by 3000 photo, shown 600 tall.
        const photo = image(page, { width: 4000, height: 3000, scaleX: 0.2, scaleY: 0.2 });
        page.select(photo);
        page.peel();
        assert.strictEqual(page.element('down-selected').disabled, false);
        page.click('down-selected');

        const [file] = page.saved;
        assert.match(file.download, /^DRAW_\d{8}T\d\d:\d\d:\d\d_selected\.png$/);
        assert.strictEqual(file.href, 'blob:1');
        assert.strictEqual(file.attached, true, 'clicked while in the page, as a browser needs');
        const [blob] = page.URL.made;
        assert.strictEqual(blob.type, 'image/png');
        assert.deepStrictEqual([blob.picture.width, blob.picture.height], [4000, 3000]);
        assert.strictEqual(page.status(), 'Downloading 1 object as PNG.');

        page.clock.advance(60000);
        assert.deepStrictEqual(page.URL.revoked, ['blob:1'], 'let go once the download has it');
    });

    it('saves a cut-out from Select area as sharp as it was taken', () => {
        const page = mountFabric({ retina: 3 });
        page.click('area-el');
        page.drag({ x: 0, y: 0 }, { x: 100, y: 50 });
        page.click('paste-el');
        // The area's picture is 3 times as many pixels, shown a third of the size.
        const cut = page.canvas.getActiveObject();
        cut.set({ width: 300, height: 150 });
        page.click('down-selected');
        const [blob] = page.URL.made;
        assert.deepStrictEqual([blob.picture.width, blob.picture.height], [300, 150]);
    });

    it('saves anything else, and many objects together, as sharp as the screen', () => {
        const page = mountFabric({ retina: 2 });
        const [a, b] = page.draw('a', 'b');
        page.select(a, b);
        const selection = page.canvas.getActiveObject();
        selection.set({ width: 300, height: 200 });
        page.click('down-selected');
        const [blob] = page.URL.made;
        assert.strictEqual(blob.picture.options.multiplier, 2);
        assert.deepStrictEqual([blob.picture.width, blob.picture.height], [600, 400]);
        assert.strictEqual(page.status(), 'Downloading 2 objects as PNG.');
        assert.deepStrictEqual(page.canvas.getActiveObjects(), [a, b], 'still selected');
    });

    it('keeps a picture to what a phone can draw', () => {
        const page = mountFabric();
        // 8000 by 6000 at its own resolution: 48 million pixels.
        const photo = image(page, { width: 8000, height: 6000, scaleX: 0.1, scaleY: 0.1 });
        page.select(photo);
        page.click('down-selected');
        const [blob] = page.URL.made;
        assert.ok(blob.picture.width * blob.picture.height <= 16 * 1000 * 1000);
        assert.ok(blob.picture.width * blob.picture.height > 15.9 * 1000 * 1000, 'as many as it can');
        assert.strictEqual(Math.round(blob.picture.width / blob.picture.height * 100), 133, 'the same shape');
    });

    it('says so when the browser cannot make the picture', () => {
        const page = mountFabric();
        const photo = image(page, { width: 100, height: 100, tooBig: true });
        page.select(photo);
        page.click('down-selected');
        assert.deepStrictEqual(page.saved, []);
        assert.strictEqual(page.status(), 'That is too big to download.');
    });
});

describe('Fabric: the size of what is selected', () => {
    /** A 4000 by 3000 photo, shown at 800 by 600, selected. */
    function photo(options) {
        const page = mountFabric({ retina: 2, ...options });
        const img = new page.fabric.Image({ name: 'photo', left: 30, top: 40, width: 4000, height: 3000, scaleX: 0.2, scaleY: 0.2 });
        page.canvas.add(img);
        page.select(img);
        page.peel();
        return { page, img };
    }
    // To a thousandth of a pixel: scaling leaves floating point dust.
    const shown = obj => { const b = obj.getBoundingRect(); return [b.left, b.top, b.width, b.height].map(v => Math.round(v * 1000) / 1000); };
    const downloaded = page => { page.click('down-selected'); const p = page.URL.made.at(-1).picture; return [p.width, p.height]; };

    it('is off with nothing selected', () => {
        const page = mountFabric();
        page.peel();
        for (const id of ['fit-width', 'fit-height', 'set-width', 'set-height']) {
            assert.strictEqual(page.element(id).disabled, true, id);
        }
        page.click('fit-width');
        assert.strictEqual(page.status(), 'Nothing selected to resize.');
    });

    it('fits an image to the canvas width, along its left edge, and still downloads it at its own resolution', () => {
        const { page, img } = photo({ width: 1200, height: 700 });
        assert.strictEqual(page.element('fit-width').disabled, false);
        page.click('fit-width');
        assert.deepStrictEqual(shown(img), [0, 40, 1200, 900]);
        assert.strictEqual(page.status(), 'Fitted 1 object to the canvas width.');
        assert.strictEqual(page.canvas.getActiveObject(), img, 'still selected');
        assert.deepStrictEqual(downloaded(page), [4000, 3000]);
    });

    it('fits an image to the canvas height, along its top edge', () => {
        const { page, img } = photo({ width: 1200, height: 700 });
        page.click('fit-height');
        assert.deepStrictEqual(shown(img), [30, 0, 933.333, 700]);
        assert.strictEqual(page.status(), 'Fitted 1 object to the canvas height.');
    });

    it('sets an image a size in pixels, and Download selected saves it exactly so', () => {
        const { page, img } = photo();
        page.element('size-px').value = '1023';
        page.click('set-width');
        assert.deepStrictEqual(shown(img), [30, 40, 1023, 767.25], 'its top left corner where it was');
        assert.strictEqual(page.status(), 'Set 1 object 1023 px wide: Download selected saves it so.');
        assert.deepStrictEqual(downloaded(page), [1023, 767]);

        page.element('size-px').value = '500';
        page.click('set-height');
        assert.deepStrictEqual(downloaded(page), [667, 500]);
        const crop = page.URL.made.at(-1).picture.options;
        assert.strictEqual(crop.multiplier, 1, 'as big as it is shown, not as the screen has pixels');

        // Fitted again: its own resolution again.
        page.click('fit-width');
        assert.deepStrictEqual(downloaded(page), [4000, 3000]);
    });

    it('keeps a size set through Copy and Paste', () => {
        const { page } = photo();
        page.element('size-px').value = '640';
        page.click('set-width');
        page.click('copy-el');
        page.click('paste-el');
        const pasted = page.canvas.getActiveObject();
        assert.strictEqual(pasted.sizeFixed, true);
        assert.deepStrictEqual(downloaded(page), [640, 480]);
    });

    it('resizes each of many selected objects on its own, and keeps them selected', () => {
        const page = mountFabric({ width: 1000 });
        const [a, b] = page.draw('a', 'b');
        a.set({ left: 10, top: 10, width: 100, height: 50 });
        b.set({ left: 300, top: 200, width: 20, height: 40 });
        page.select(a, b);
        page.click('fit-width');
        assert.deepStrictEqual(shown(a), [0, 10, 1000, 500]);
        assert.deepStrictEqual(shown(b), [0, 200, 1000, 2000]);
        assert.deepStrictEqual(page.canvas.getActiveObjects(), [a, b]);
        assert.strictEqual(page.status(), 'Fitted 2 objects to the canvas width.');
    });

    it('takes whole pixels from 1 to 20000 only', () => {
        const { page, img } = photo();
        for (const bad of ['0', '-5', '12.5', 'abc', '', '20001']) {
            page.element('size-px').value = bad;
            page.click('set-width');
            assert.strictEqual(page.status(), 'Give the size in whole pixels, from 1 to 20000.', bad);
        }
        assert.deepStrictEqual(shown(img), [30, 40, 800, 600], 'as it was');
    });
});

describe('Fabric: the brush', () => {
    it('sets the brush as a slider moves, and shows its value', () => {
        const page = mountFabric();
        page.slide('drawing-line-width', 42);
        assert.strictEqual(page.canvas.freeDrawingBrush.width, 42);
        assert.strictEqual(page.element('drawing-line-width-value').textContent, '42');

        page.slide('drawing-shadow-width', 7);
        assert.strictEqual(page.canvas.freeDrawingBrush.shadow.blur, 7);
        page.slide('drawing-shadow-offset', 5);
        assert.strictEqual(page.canvas.freeDrawingBrush.shadow.offsetX, 5);
        assert.strictEqual(page.canvas.freeDrawingBrush.shadow.offsetY, 5);
        assert.strictEqual(page.element('drawing-shadow-offset-value').textContent, '5');
    });

    it('takes a new mode with the settings the controls have', () => {
        const page = mountFabric();
        page.slide('drawing-line-width', 20);
        page.element('drawing-color').value = '#ff0000';
        page.element('drawing-color').fire('input');

        const mode = page.element('drawing-mode-selector');
        mode.value = 'Spray';
        mode.fire('change');
        assert.strictEqual(page.canvas.freeDrawingBrush.kind, 'SprayBrush');
        assert.strictEqual(page.canvas.freeDrawingBrush.width, 20);
        assert.strictEqual(page.canvas.freeDrawingBrush.color, '#ff0000');

        mode.value = 'diamond';
        mode.fire('change');
        assert.strictEqual(page.canvas.freeDrawingBrush.kind, 'PatternBrush');
        assert.strictEqual(typeof page.canvas.freeDrawingBrush.getPatternSrc, 'function');
        assert.strictEqual(page.canvas.freeDrawingBrush.width, 20);
    });
});

describe('Fabric: text and files', () => {
    it('adds the text typed, and not an empty one', () => {
        const page = mountFabric();
        page.click('add-text');
        assert.deepStrictEqual(page.canvas.objects, []);
        assert.strictEqual(page.status(), 'Type the text to add first.');

        page.element('textblob').value = 'Hello';
        page.element('textblob').fire('keydown', { key: 'Enter' });
        assert.strictEqual(page.canvas.objects.length, 1);
        assert.strictEqual(page.canvas.objects[0].objects[1].text, 'Hello');
        assert.strictEqual(page.element('textblob').value, '');
    });

    it('adds a textbox of the text typed, selected and ready to edit', () => {
        const page = mountFabric();
        page.peel();
        page.element('drawing-color').value = '#123456';
        page.element('textblob').value = 'Wraps at its width';
        page.click('add-textbox');

        const [box] = page.canvas.objects;
        assert.strictEqual(box.type, 'textbox');
        assert.strictEqual(box.text, 'Wraps at its width');
        assert.strictEqual(box.width, 250);
        assert.strictEqual(box.fill, '#123456');
        assert.strictEqual(page.canvas.getActiveObject(), box);
        assert.strictEqual(page.canvas.isDrawingMode, false, 'a textbox is edited with drawing mode off');
        assert.strictEqual(page.element('drawing-mode').getAttribute('aria-pressed'), 'false');
        assert.strictEqual(page.element('selected').textContent, '1 object selected');
        assert.strictEqual(page.element('textblob').value, '');

        page.peel();
        assert.strictEqual(page.canvas.getActiveObject(), box, 'still selected on the drawing');
    });

    it('adds a textbox with a word to edit when none was typed', () => {
        const page = mountFabric({ width: 200 });
        page.click('add-textbox');
        const [box] = page.canvas.objects;
        assert.strictEqual(box.text, 'Text');
        assert.ok(box.left + box.width <= 200, 'fits on a narrow canvas');
    });

    it('writes new text in the font chosen', () => {
        const page = mountFabric();
        const fonts = page.element('font-selector');
        assert.strictEqual(fonts.options[fonts.selectedIndex].textContent, 'Comic Sans', 'as the bubble always was');

        fonts.value = "'Times New Roman', Times, serif";
        fonts.fire('change');
        assert.strictEqual(page.status(), 'Font Serif for new text.');
        assert.strictEqual(fonts.style.fontFamily, fonts.value, 'the list shows the font in it');

        page.element('textblob').value = 'bubble';
        page.click('add-text');
        page.element('textblob').value = 'box';
        page.click('add-textbox');
        const [bubble, box] = page.canvas.objects;
        assert.strictEqual(bubble.objects[1].fontFamily, fonts.value);
        assert.strictEqual(box.fontFamily, fonts.value);
    });

    it('sets the font of every selected text, in a bubble or a textbox', () => {
        const page = mountFabric();
        page.element('textblob').value = 'bubble';
        page.click('add-text');
        page.click('add-textbox');
        const [bubble, box] = page.canvas.objects;
        const [line] = page.draw('line');
        page.select(bubble, box, line);
        page.peel();

        const fonts = page.element('font-selector');
        fonts.value = "'Courier New', Courier, monospace";
        fonts.fire('change');
        assert.strictEqual(bubble.objects[1].fontFamily, fonts.value);
        assert.strictEqual(bubble.dirty, true, 'the bubble draws itself again');
        assert.strictEqual(box.fontFamily, fonts.value);
        assert.strictEqual(page.status(), 'Font Monospace set on 2 texts.');
    });

    it('shows the font of the selected text', () => {
        const page = mountFabric();
        page.click('add-textbox');
        const [box] = page.canvas.objects;
        box.set('fontFamily', 'Impact, \'Arial Black\', sans-serif');
        page.select(box);
        page.peel();
        assert.strictEqual(page.element('font-selector').value, "Impact, 'Arial Black', sans-serif");

        // A font the list does not have leaves it as it is.
        box.set('fontFamily', 'Wingdings');
        page.peel();
        page.peel();
        assert.strictEqual(page.element('font-selector').value, "Impact, 'Arial Black', sans-serif");
    });

    it('loads a drawing from its JSON, and refuses a file that is not one', () => {
        const page = mountFabric();
        page.load('jsoninput', '{"objects":[{"text":"é"}]}');
        assert.deepStrictEqual(JSON.parse(JSON.stringify(page.canvas.loaded)), { objects: [{ text: 'é' }] });
        assert.strictEqual(page.status(), 'Drawing loaded.');
        assert.strictEqual(page.element('jsoninput').value, '', 'the same file can be loaded again');

        page.load('jsoninput', 'not json');
        assert.strictEqual(page.status(), 'That file is not a drawing in JSON.');
    });

    it('loads an image as tall as the canvas', () => {
        const page = mountFabric();
        page.load('fileinput', 'PNGDATA');
        const img = page.Image.made.at(-1);
        assert.strictEqual(img.src, 'data:image/png;base64,PNGDATA');
        img.onload();
        assert.strictEqual(page.canvas.objects[0].height, 600);
    });

    it('downloads the drawing as PNG and as JSON', () => {
        const page = mountFabric();
        page.draw('a');
        page.click('down-png');
        assert.match(page.element('down-png').download, /^DRAW_\d{8}T\d\d:\d\d:\d\d\.png$/);
        assert.strictEqual(page.element('down-png').href, 'data:image/png;base64,AAAA');

        page.click('down-json');
        assert.match(page.element('down-json').download, /\.json$/);
        assert.deepStrictEqual(JSON.parse(decodeURIComponent(page.element('down-json').href.split(',')[1])), { objects: ['a'], kept: ['sizeFixed'] });
    });
});

describe('Fabric: versions', () => {
    it('loads every script and the stylesheet with the version the service worker caches', () => {
        const version = /CACHE_NAME = 'fabric-draw-v(\d+)'/.exec(read('sw.js'))[1];
        const tags = [...read('index.html').matchAll(/\?v=(\d+)/g)].map(m => m[1]);
        assert.ok(tags.length >= 3);
        assert.deepStrictEqual([...new Set(tags)], [version]);
    });
});
