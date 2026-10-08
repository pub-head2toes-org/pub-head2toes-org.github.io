/* Fabric PWA - the drawing on top, its controls under it: the corner peels one off the other. */
(function () {
    'use strict';

    const $ = id => document.getElementById(id);

    // The canvas fills the drawing page; fabric wraps it in a div of its own.
    const el = $('c');
    el.width = window.innerWidth;
    el.height = window.innerHeight;
    const canvas = window.__canvas = new fabric.Canvas('c', { isDrawingMode: true });

    fabric.Object.prototype.transparentCorners = false;

    // Which page is on top: the drawing, or its controls.
    const ui = { front: 'draw', peeling: false };
    // Drawing mode as the user set it, and the shape it draws - a key of `shapes` - or null for a brush.
    const tools = { drawing: true, shape: null };

    /**
     * The canvas as the tools say: a brush draws in fabric's drawing mode; a shape
     * draws with it off, and with nothing to pick or move while a shape is dragged.
     */
    function applyDrawing() {
        const shaping = tools.drawing && !!tools.shape;
        Object.assign(canvas, {
            isDrawingMode: tools.drawing && !tools.shape,
            selection: !shaping,
            skipTargetFind: shaping,
            defaultCursor: shaping ? 'crosshair' : 'default'
        });
    }
    // What Copy took, for Paste to add again and again.
    let clipboard = null;
    let sayTimer = null;

    function say(text) {
        $('status').textContent = text || '';
        clearTimeout(sayTimer);
        if (text) {
            sayTimer = setTimeout(() => { $('status').textContent = ''; }, 4000);
        }
    }

    const plural = (n, one) => n + ' ' + one + (n === 1 ? '' : 's');

    /** What the controls show of the canvas: what is selected, whether there is anything to paste. */
    function refresh() {
        const chosen = canvas.getActiveObjects().length;
        $('selected').textContent = chosen ? plural(chosen, 'object') + ' selected' : 'Nothing selected';
        $('copy-el').disabled = !chosen;
        $('remove-el').disabled = !chosen;
        $('down-selected').disabled = !chosen;
        ['fit-width', 'fit-height', 'set-width', 'set-height'].forEach(id => { $(id).disabled = !chosen; });
        $('paste-el').disabled = !clipboard;
        $('drawing-mode').setAttribute('aria-pressed', String(tools.drawing));
        showFont();
        showFill();
    }

    canvas.on('selection:created', refresh);
    canvas.on('selection:updated', refresh);
    canvas.on('selection:cleared', refresh);

    /** The canvas as large as the window: done while the drawing is on top, not for a keyboard under it. */
    function fit() {
        const width = window.innerWidth;
        const height = window.innerHeight;
        if (width !== canvas.getWidth() || height !== canvas.getHeight()) {
            canvas.setDimensions({ width: width, height: height });
        }
        canvas.calcOffset();
    }

    window.addEventListener('resize', () => { if (ui.front === 'draw' && !ui.peeling) fit(); });

    // ---- peeling: the top page comes off, and shows the one under it -----

    // As long as the animation in styles.css (--peel).
    const PEEL_MS = 650;
    const page = name => $(name === 'draw' ? 'page_draw' : 'page_controls');

    function reduced() {
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    /**
     * Back to the top of both pages: only the list of controls scrolls. A browser
     * without overflow: clip scrolls a page to show an input that has focus - a
     * file input as its picker opens - and then the header and corner are gone.
     */
    function unscroll() {
        [page('draw'), page('controls')].forEach(function (one) {
            one.scrollTop = 0;
            one.scrollLeft = 0;
        });
        if (window.scrollTo) window.scrollTo(0, 0);
    }

    /**
     * Puts `name` on top: by peeling the other off, or at once when `animate` is false.
     * The canvas keeps its selection either way: Copy and Remove act on it.
     */
    function bring(name, animate) {
        if (ui.front === name || ui.peeling) {
            return;
        }
        const from = page(ui.front);
        const to = page(name);
        const swap = function () {
            from.classList.remove('front', 'peeling');
            from.inert = true;
            to.classList.add('front');
            ui.front = name;
            ui.peeling = false;
            if (name === 'draw') {
                fit();
                $('peel_top').focus();
            } else {
                $('peel_back').focus();
            }
        };
        // The page underneath is live from the start: it shows as the top one lifts.
        to.inert = false;
        unscroll();
        if (name === 'controls') {
            // An area not dragged yet is let go: the drawing is as it was.
            endArea();
            refresh();
        }
        if (animate === false || reduced()) {
            swap();
            return;
        }
        ui.peeling = true;
        from.classList.add('peeling');
        setTimeout(swap, PEEL_MS);
    }

    $('peel_top').addEventListener('click', () => bring('controls'));
    $('peel_back').addEventListener('click', () => bring('draw'));

    // ---- the selection --------------------------------------------------

    function copy() {
        const active = canvas.getActiveObject();
        if (!active) {
            say('Nothing selected to copy.');
            return;
        }
        // A clone: what changes on the canvas later does not change the copy.
        active.clone(function (cloned) {
            clipboard = cloned;
            refresh();
            say('Copied ' + plural(canvas.getActiveObjects().length, 'object') + '.');
        }, KEPT);
    }

    // What fabric does not keep of an object, but a copy and a saved drawing should: see setSize.
    const KEPT = ['sizeFixed'];

    function paste() {
        if (!clipboard) {
            say('Nothing copied to paste.');
            return;
        }
        // Cloned again, so it can be pasted many times.
        clipboard.clone(function (cloned) {
            canvas.discardActiveObject();
            cloned.set({ left: cloned.left + 10, top: cloned.top + 10, evented: true });
            if (cloned.type === 'activeSelection') {
                // An active selection needs the canvas, and its objects added one by one.
                cloned.canvas = canvas;
                cloned.forEachObject(obj => canvas.add(obj));
                cloned.setCoords();
            } else {
                canvas.add(cloned);
            }
            clipboard.top += 10;
            clipboard.left += 10;
            canvas.setActiveObject(cloned);
            canvas.requestRenderAll();
            refresh();
            say('Pasted.');
        }, KEPT);
    }

    /** Removes every selected object, not only one. */
    function remove() {
        const chosen = canvas.getActiveObjects();
        if (!chosen.length) {
            say('Nothing selected to remove.');
            return;
        }
        // Discarded first: a selection of many hands its objects back to the canvas as they are.
        canvas.discardActiveObject();
        canvas.remove.apply(canvas, chosen);
        canvas.requestRenderAll();
        refresh();
        say('Removed ' + plural(chosen.length, 'object') + '.');
    }

    // ---- an area: all that is in it, copied as one new image ---------------

    // While on, a drag on the drawing marks the area, and moves nothing.
    const area = { on: false };
    // Smaller than this either way, an area is a tap, not a drag.
    const AREA_MIN = 4;

    /** The next drag on the drawing copies what is under it: the drawing comes to the top for it. */
    function selectArea() {
        if (!area.on) {
            canvas.discardActiveObject();
            Object.assign(canvas, { isDrawingMode: false, selection: false, skipTargetFind: true, defaultCursor: 'crosshair' });
            area.on = true;
            canvas.requestRenderAll();
        }
        say('Drag over the part to copy.');
        bring('draw');
    }

    /** The drawing as it was before the area: drawing mode, its tool and all. */
    function endArea() {
        if (!area.on) return;
        if (drag.tool === areaTool) {
            canvas.remove(drag.shape);
            Object.assign(drag, { tool: null, start: null, end: null, shape: null });
        }
        area.on = false;
        applyDrawing();
        canvas.requestRenderAll();
        refresh();
    }

    /** The area from `start` to `end`, inside the canvas, in whole pixels. */
    function areaBox(start, end) {
        const x = v => Math.round(Math.min(Math.max(v, 0), canvas.getWidth()));
        const y = v => Math.round(Math.min(Math.max(v, 0), canvas.getHeight()));
        const [x0, x1, y0, y1] = [x(start.x), x(end.x), y(start.y), y(end.y)];
        return { left: Math.min(x0, x1), top: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
    }

    const areaTool = {
        // A dashed frame, as the area is dragged.
        start: point => new fabric.Rect({
            left: point.x, top: point.y, width: 0, height: 0,
            fill: 'rgba(0, 94, 122, 0.12)', stroke: '#005e7a', strokeWidth: 1, strokeDashArray: [6, 4],
            selectable: false, evented: false, excludeFromExport: true
        }),
        move: (frame, start, end) => frame.set(areaBox(start, end)),
        end(frame, start, end) {
            const box = areaBox(start, end);
            // The frame goes before the copy is taken: it is not in it.
            canvas.remove(frame);
            endArea();
            if (box.width < AREA_MIN || box.height < AREA_MIN) {
                say('Too small to copy: Select area again, and drag over the part.');
                return;
            }
            cutout(box);
        }
    };

    /** What is in `box` on the canvas, as one new image where it was: Paste adds it. */
    function cutout(box) {
        // As many pixels as the screen has: the copy is as sharp as the drawing.
        const retina = canvas.getRetinaScaling();
        const url = canvas.toDataURL({ format: 'png', enableRetinaScaling: true, ...box });
        fabric.Image.fromURL(url, function (img) {
            img.set({ left: box.left, top: box.top, scaleX: 1 / retina, scaleY: 1 / retina });
            clipboard = img;
            refresh();
            say('Area copied: Paste adds it as a new image.');
        });
    }

    // ---- shapes: a straight line, a rectangle, a circle - each as it is dragged ----

    // Smaller than this, a shape is a tap: none is drawn.
    const SHAPE_MIN = 4;

    /** Where a straight line from `start` ends: across when the drag goes more across than down, else down. */
    function straightEnd(start, end) {
        return Math.abs(end.x - start.x) >= Math.abs(end.y - start.y)
            ? { x: end.x, y: start.y }
            : { x: start.x, y: end.y };
    }

    /** The brush's color, width and shadow, for the outline of a shape: as wide when it is resized later. */
    function outline() {
        return {
            stroke: drawingColorEl.value,
            strokeWidth: parseInt(drawingLineWidthEl.value, 10) || 1,
            strokeUniform: true,
            shadow: brushShadow()
        };
    }

    // How each shape starts at a point, fits the drag from `start` to `end`, and how big it came out.
    const shapes = {
        // Across or down, round at the ends as the pencil is.
        straight: {
            make: point => new fabric.Line([point.x, point.y, point.x, point.y], { ...outline(), strokeLineCap: 'round' }),
            fit(line, start, end) {
                const to = straightEnd(start, end);
                line.set({ x2: to.x, y2: to.y });
            },
            size: line => Math.abs(line.x2 - line.x1) + Math.abs(line.y2 - line.y1)
        },
        // From the corner the drag started at to the one it is at: an outline only.
        rectangle: {
            make: point => new fabric.Rect({ left: point.x, top: point.y, width: 0, height: 0, ...outline(), fill: shapeFill(), strokeLineJoin: 'round' }),
            fit(rect, start, end) {
                rect.set({
                    left: Math.min(start.x, end.x),
                    top: Math.min(start.y, end.y),
                    width: Math.abs(end.x - start.x),
                    height: Math.abs(end.y - start.y)
                });
            },
            size: rect => Math.max(rect.width, rect.height)
        },
        // In the square from the corner the drag started at, as wide as the drag goes furthest.
        circle: {
            make: point => new fabric.Circle({ left: point.x, top: point.y, radius: 0, ...outline(), fill: shapeFill() }),
            fit(circle, start, end) {
                const across = Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y));
                circle.set({
                    radius: across / 2,
                    left: end.x < start.x ? start.x - across : start.x,
                    top: end.y < start.y ? start.y - across : start.y
                });
            },
            size: circle => circle.radius * 2
        }
    };

    // ---- the fill of a rectangle or a circle --------------------------------

    const FILLED_TYPES = ['rect', 'circle'];
    const COLOR = /^#[0-9a-f]{6}$/i;

    /** Inside a new rectangle or circle: the fill color, or nothing with Fill off. */
    function shapeFill() {
        return $('shape-fill').checked ? $('shape-fill-color').value : 'transparent';
    }

    const selectedShapes = () => canvas.getActiveObjects().filter(o => FILLED_TYPES.includes(o.type));

    /** The fill of the selected shape, when it has one the controls can show: what a change starts from. */
    function showFill() {
        const [first] = selectedShapes();
        if (!first) return;
        const filled = typeof first.fill === 'string' && COLOR.test(first.fill);
        $('shape-fill').checked = filled;
        if (filled) $('shape-fill-color').value = first.fill.toLowerCase();
    }

    /** Fill on in `color`, or off with 'none': for new shapes, and every selected rectangle and circle. */
    function setFill(color) {
        if (color === 'none') {
            $('shape-fill').checked = false;
        } else if (typeof color === 'string' && COLOR.test(color)) {
            $('shape-fill').checked = true;
            $('shape-fill-color').value = color;
        } else {
            say('No such color.');
            return;
        }
        const chosen = selectedShapes();
        chosen.forEach(o => o.set('fill', shapeFill()));
        canvas.requestRenderAll();
        const what = $('shape-fill').checked ? 'Fill on' : 'Fill off';
        say(chosen.length ? what + ' for ' + plural(chosen.length, 'shape') + '.' : what + ' for new shapes.');
    }

    $('shape-fill').addEventListener('change', function () {
        run('fill', this.checked ? $('shape-fill-color').value : 'none');
    });
    // A color picked is a fill wanted: it turns Fill on.
    $('shape-fill-color').addEventListener('input', function () { run('fill', this.value); });

    const shapeTool = {
        start: point => shapes[tools.shape].make(point),
        move: (shape, start, end) => shapes[tools.shape].fit(shape, start, end),
        end(shape, start, end) {
            shapes[tools.shape].fit(shape, start, end);
            if (shapes[tools.shape].size(shape) < SHAPE_MIN) {
                canvas.remove(shape);
            } else {
                shape.setCoords();
            }
            canvas.requestRenderAll();
        }
    };

    // ---- the drag tools: an area to copy, a shape to draw -------------------

    // The tool of the drag going on, where it started and where it is, and what it shows.
    const drag = { tool: null, start: null, end: null, shape: null };

    function dragTool() {
        if (area.on) return areaTool;
        return tools.drawing && tools.shape ? shapeTool : null;
    }

    canvas.on('mouse:down', function (opt) {
        const tool = dragTool();
        if (!tool) return;
        const point = canvas.getPointer(opt.e);
        Object.assign(drag, { tool: tool, start: point, end: point, shape: tool.start(point) });
        canvas.add(drag.shape);
    });

    canvas.on('mouse:move', function (opt) {
        if (!drag.tool) return;
        // Where the drag is now: a touch that ends has no point of its own.
        drag.end = canvas.getPointer(opt.e);
        drag.tool.move(drag.shape, drag.start, drag.end);
        drag.shape.setCoords();
        canvas.requestRenderAll();
    });

    canvas.on('mouse:up', function () {
        if (!drag.tool) return;
        const { tool, shape, start, end } = drag;
        Object.assign(drag, { tool: null, start: null, end: null, shape: null });
        tool.end(shape, start, end);
    });

    function clear() {
        if (!window.confirm('Clear the whole drawing?')) {
            return;
        }
        canvas.clear();
        refresh();
        say('Cleared.');
    }

    function toggleDrawing() {
        tools.drawing = !tools.drawing;
        applyDrawing();
        refresh();
        say(tools.drawing ? 'Drawing mode on.' : 'Drawing mode off: objects can be selected.');
    }

    // ---- text and images ------------------------------------------------

    const TEXT_TYPES = ['text', 'i-text', 'textbox'];

    /** The texts in what is selected: on their own, or in a bubble with the group they are in. */
    function selectedTexts() {
        const texts = [];
        canvas.getActiveObjects().forEach(function (obj) {
            if (TEXT_TYPES.includes(obj.type)) {
                texts.push({ text: obj });
            } else if (obj.type === 'group') {
                obj.getObjects().filter(o => TEXT_TYPES.includes(o.type)).forEach(text => texts.push({ text: text, group: obj }));
            }
        });
        return texts;
    }

    /** The font of the selected text, when the list has it: what a change of font starts from. */
    function showFont() {
        const [first] = selectedTexts();
        const fonts = $('font-selector');
        if (first && [...fonts.options].some(o => o.value === first.text.fontFamily)) {
            fonts.value = first.text.fontFamily;
        }
        // The list shows its font in it.
        fonts.style.fontFamily = fonts.value;
    }

    /** The font for new text, and for every selected text: on its own or in a bubble. */
    function setFont(font) {
        const fonts = $('font-selector');
        if (font !== undefined) {
            if (![...fonts.options].some(o => o.value === font)) {
                say('No such font.');
                return;
            }
            fonts.value = font;
        }
        fonts.style.fontFamily = fonts.value;
        const texts = selectedTexts();
        texts.forEach(function (one) {
            one.text.set('fontFamily', fonts.value);
            if (one.group) one.group.dirty = true;
        });
        canvas.requestRenderAll();
        const name = fonts.options[fonts.selectedIndex].textContent;
        say(texts.length ? 'Font ' + name + ' set on ' + plural(texts.length, 'text') + '.' : 'Font ' + name + ' for new text.');
    }

    $('font-selector').addEventListener('change', function () { run('font', this.value); });

    // Each text a little further on than the one before.
    let posX = 50;
    let posY = 50;

    function nextPlace() {
        posX = (posX + 100) % Math.max(1, canvas.getWidth() - 150);
        posY = (posY + 20) % Math.max(1, canvas.getHeight() - 50);
    }

    function addText() {
        const words = $('textblob').value;
        if (!words.trim()) {
            say('Type the text to add first.');
            $('textblob').focus();
            return;
        }
        nextPlace();
        const bubble = new fabric.Circle({
            radius: 150,
            fill: '#eef',
            scaleY: 0.2,
            originX: 'center',
            originY: 'center'
        });
        const text = new fabric.Text(words, {
            fontSize: 16,
            originX: 'center',
            originY: 'center',
            fontFamily: $('font-selector').value
        });
        canvas.add(new fabric.Group([bubble, text], { left: posX, top: posY }));
        $('textblob').value = '';
        say('Text added.');
    }

    // Wider than this, a textbox wraps its lines; its corners make it wider or narrower.
    const TEXTBOX_WIDTH = 250;

    /**
     * A textbox: text that stays text, wraps at its width and is edited on the canvas.
     * It comes selected, with drawing mode off: a double-tap on it edits it.
     */
    function addTextbox() {
        const words = $('textblob').value.trim() ? $('textblob').value : 'Text';
        nextPlace();
        const box = new fabric.Textbox(words, {
            left: posX,
            top: posY,
            width: Math.max(50, Math.min(TEXTBOX_WIDTH, canvas.getWidth() - posX)),
            fontSize: 24,
            fill: drawingColorEl.value,
            fontFamily: $('font-selector').value
        });
        canvas.add(box);
        tools.drawing = false;
        applyDrawing();
        canvas.setActiveObject(box);
        canvas.requestRenderAll();
        $('textblob').value = '';
        refresh();
        say('Textbox added. Peel back and double-tap it to edit.');
    }

    $('textblob').addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
            run('text');
        }
    });

    function addImg(src) {
        const img = new Image();
        img.onload = function () {
            const picture = new fabric.Image(img);
            picture.scaleToHeight(canvas.getHeight());
            canvas.add(picture);
            say('Image loaded.');
        };
        img.onerror = () => say('That file is not an image.');
        img.src = src;
    }

    // The picker closed, with a file or without: the page as it was.
    ['fileinput', 'jsoninput'].forEach(function (id) {
        $(id).addEventListener('change', unscroll);
        $(id).addEventListener('cancel', unscroll);
    });

    // Read, then cleared: the same file can be loaded again.
    $('fileinput').addEventListener('change', function () {
        const file = this.files[0];
        this.value = '';
        if (!file) return;
        const reader = new FileReader();
        reader.addEventListener('load', () => addImg(reader.result));
        reader.readAsDataURL(file);
    });

    $('jsoninput').addEventListener('change', function () {
        const file = this.files[0];
        this.value = '';
        if (!file) return;
        const reader = new FileReader();
        reader.addEventListener('load', function () {
            let json;
            try {
                json = JSON.parse(reader.result);
            } catch (e) {
                say('That file is not a drawing in JSON.');
                return;
            }
            canvas.loadFromJSON(json, function () {
                canvas.requestRenderAll();
                refresh();
                say('Drawing loaded.');
            });
        });
        reader.readAsText(file);
    });

    // ---- downloads: the link gets its file as it is clicked ---------------

    function stamp() {
        return 'DRAW_' + new Date().toISOString().slice(0, 19).replace(/-/g, '');
    }

    $('down-png').addEventListener('click', function () {
        this.download = stamp() + '.png';
        this.href = canvas.toDataURL({ format: 'png' });
    });

    $('down-json').addEventListener('click', function () {
        this.download = stamp() + '.json';
        this.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(canvas.toJSON(KEPT)));
    });

    // The most pixels a PNG of the selection has: about what the largest canvas a phone draws holds.
    const MAX_PIXELS = 16 * 1000 * 1000;

    /**
     * How many pixels the PNG has for each one on the canvas: an image alone at its own
     * resolution - as loaded, not as shrunk to the screen - anything else as sharp as the screen.
     */
    function selectedScale(active) {
        // Given a size in pixels, it is saved as big as it is shown: see setSize.
        if (active.sizeFixed) {
            return 1;
        }
        let multiplier = active.type === 'image'
            ? 1 / Math.max(Math.abs(active.scaleX), Math.abs(active.scaleY))
            : canvas.getRetinaScaling();
        const bounds = active.getBoundingRect(true, true);
        const pixels = bounds.width * bounds.height * multiplier * multiplier;
        if (pixels > MAX_PIXELS) {
            multiplier *= Math.sqrt(MAX_PIXELS / pixels);
        }
        return multiplier;
    }

    /**
     * The crop that makes the PNG of `obj` exactly as big as it is shown: fabric draws an
     * object alone centered on a canvas a whole and even number of pixels wide and tall.
     */
    function exactly(obj) {
        const bounds = obj.getBoundingRect(true, true);
        const even = v => { const n = Math.floor(v); return n + n % 2; };
        return {
            left: (even(bounds.width) - bounds.width) / 2,
            top: (even(bounds.height) - bounds.height) / 2,
            width: Math.round(bounds.width),
            height: Math.round(bounds.height)
        };
    }

    /** Saves `blob` as a file called `name`, by a link clicked for it. */
    function save(blob, name) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        // Long enough for the download to start with it.
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    /** Only what is selected, as a PNG cut to it, on nothing: one object, or many together. */
    function downloadSelected() {
        const active = canvas.getActiveObject();
        if (!active) {
            say('Nothing selected to download.');
            return;
        }
        const count = canvas.getActiveObjects().length;
        const options = { format: 'png', multiplier: selectedScale(active) };
        if (active.sizeFixed && !active.shadow) {
            Object.assign(options, exactly(active));
        }
        const picture = active.toCanvasElement(options);
        picture.toBlob(function (blob) {
            if (!blob) {
                say('That is too big to download.');
                return;
            }
            save(blob, stamp() + '_selected.png');
            say('Downloading ' + plural(count, 'object') + ' as PNG.');
        }, 'image/png');
    }

    // ---- the size of what is selected ----------------------------------------

    // The most pixels a size can be given in.
    const MAX_SIZE = 20000;

    /**
     * Scales `obj` evenly, so that what it covers on the canvas is `size` pixels across
     * `axis` - 'width' or 'height' - its top left corner where it was.
     */
    function scaleTo(obj, axis, size) {
        const before = obj.getBoundingRect(true, true);
        const factor = size / before[axis];
        obj.set({ scaleX: obj.scaleX * factor, scaleY: obj.scaleY * factor });
        obj.setCoords();
        const after = obj.getBoundingRect(true, true);
        obj.set({ left: obj.left + before.left - after.left, top: obj.top + before.top - after.top });
        obj.setCoords();
    }

    /**
     * Resizes every selected object on its own, by `resize(obj)`: out of a selection of many,
     * whose objects are placed in it, not on the canvas; then selected again, as they were.
     */
    function resizeSelected(resize) {
        const chosen = canvas.getActiveObjects();
        if (!chosen.length) {
            say('Nothing selected to resize.');
            return 0;
        }
        canvas.discardActiveObject();
        chosen.forEach(resize);
        canvas.setActiveObject(chosen.length === 1 ? chosen[0] : new fabric.ActiveSelection(chosen, { canvas: canvas }));
        canvas.requestRenderAll();
        refresh();
        return chosen.length;
    }

    /** As wide - or as tall - as the canvas, along its left - or top - edge. An image still downloads at its own resolution. */
    function fitCanvas(axis) {
        const count = resizeSelected(function (obj) {
            scaleTo(obj, axis, axis === 'width' ? canvas.getWidth() : canvas.getHeight());
            const bounds = obj.getBoundingRect(true, true);
            obj.set(axis === 'width' ? { left: obj.left - bounds.left } : { top: obj.top - bounds.top });
            obj.setCoords();
            obj.sizeFixed = false;
        });
        if (count) say('Fitted ' + plural(count, 'object') + ' to the canvas ' + axis + '.');
    }

    /**
     * `pixels` wide - or tall - and Download selected saves it so: shown as big as it is
     * saved, and the image's own pixels kept, to be made bigger again later as sharp.
     */
    function setSize(axis, pixels) {
        const input = $('size-px');
        const size = Number(pixels === undefined ? input.value : pixels);
        if (!Number.isInteger(size) || size < 1 || size > MAX_SIZE) {
            say('Give the size in whole pixels, from 1 to ' + MAX_SIZE + '.');
            return;
        }
        input.value = String(size);
        const count = resizeSelected(function (obj) {
            scaleTo(obj, axis, size);
            obj.sizeFixed = true;
        });
        if (count) say('Set ' + plural(count, 'object') + ' ' + size + ' px ' + (axis === 'width' ? 'wide' : 'tall') + ': Download selected saves it so.');
    }

    // ---- the commands: what a button runs, by the name in its data-command ----

    // A remote device can send these names later, as text.
    const commands = {
        copy: copy,
        paste: paste,
        remove: remove,
        area: selectArea,
        clear: clear,
        drawing: toggleDrawing,
        text: addText,
        textbox: addTextbox,
        font: setFont,
        fill: setFill,
        'download-selected': downloadSelected,
        'fit-width': () => fitCanvas('width'),
        'fit-height': () => fitCanvas('height'),
        width: pixels => setSize('width', pixels),
        height: pixels => setSize('height', pixels)
    };

    /** Runs a command by its name, with its value when it takes one: `font` takes the font, `fill` a color or 'none', `width` and `height` the pixels. */
    function run(name, value) {
        if (commands.hasOwnProperty(name)) {
            commands[name](value);
        }
    }

    document.querySelectorAll('[data-command]').forEach(function (button) {
        button.addEventListener('click', () => run(button.getAttribute('data-command')));
    });

    // ---- the brush --------------------------------------------------------

    const drawingColorEl = $('drawing-color');
    const drawingShadowColorEl = $('drawing-shadow-color');
    const drawingLineWidthEl = $('drawing-line-width');
    const drawingShadowWidth = $('drawing-shadow-width');
    const drawingShadowOffset = $('drawing-shadow-offset');

    /** A pattern brush whose tile `draw(ctx, color)` paints, `size` pixels square. */
    function patternBrush(size, draw) {
        const brush = new fabric.PatternBrush(canvas);
        brush.getPatternSrc = function () {
            const patternCanvas = fabric.document.createElement('canvas');
            patternCanvas.width = patternCanvas.height = size;
            draw(patternCanvas.getContext('2d'), this.color);
            return patternCanvas;
        };
        return brush;
    }

    function lines(ctx, color, x0, y0, x1, y1) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.closePath();
        ctx.stroke();
    }

    const patterns = {};
    if (fabric.PatternBrush) {
        patterns.hline = patternBrush(10, (ctx, color) => lines(ctx, color, 0, 5, 10, 5));
        patterns.vline = patternBrush(10, (ctx, color) => lines(ctx, color, 5, 0, 5, 10));
        patterns.square = patternBrush(12, function (ctx, color) {
            ctx.fillStyle = color;
            ctx.fillRect(0, 0, 10, 10);
        });

        const diamond = new fabric.Rect({ width: 10, height: 10, angle: 45 });
        const diamondWidth = diamond.getBoundingRect().width;
        patterns.diamond = patternBrush(diamondWidth + 5, function (ctx, color) {
            diamond.set({ left: diamondWidth / 2, top: diamondWidth / 2, fill: color });
            diamond.render(ctx);
        });

        const img = new Image();
        img.src = './icon-192.png';
        patterns.texture = new fabric.PatternBrush(canvas);
        patterns.texture.source = img;
    }

    /** The shadow as the controls set it: for a brush, and for a straight line. */
    function brushShadow() {
        const offset = parseInt(drawingShadowOffset.value, 10) || 0;
        return new fabric.Shadow({
            blur: parseInt(drawingShadowWidth.value, 10) || 0,
            offsetX: offset,
            offsetY: offset,
            affectStroke: true,
            color: drawingShadowColorEl.value
        });
    }

    /** The brush as the controls set it. */
    function setBrush(brush) {
        canvas.freeDrawingBrush = brush;
        if (!brush) return;
        brush.color = drawingColorEl.value;
        brush.width = parseInt(drawingLineWidthEl.value, 10) || 1;
        brush.shadow = brushShadow();
    }

    // A shape is a tool of its own: the brush stays as it was, for when another mode is picked.
    $('drawing-mode-selector').addEventListener('change', function () {
        tools.shape = shapes.hasOwnProperty(this.value) ? this.value : null;
        if (!tools.shape) {
            setBrush(patterns[this.value] || new fabric[this.value + 'Brush'](canvas));
        }
        applyDrawing();
    });

    // A slider shows its value as it moves, and the brush takes it at once.
    function slider(input, apply) {
        input.addEventListener('input', function () {
            $(input.id + '-value').textContent = input.value;
            if (canvas.freeDrawingBrush) apply(parseInt(input.value, 10) || 0);
        });
    }

    slider(drawingLineWidthEl, value => { canvas.freeDrawingBrush.width = value || 1; });
    slider(drawingShadowWidth, value => { canvas.freeDrawingBrush.shadow.blur = value; });
    slider(drawingShadowOffset, function (value) {
        canvas.freeDrawingBrush.shadow.offsetX = value;
        canvas.freeDrawingBrush.shadow.offsetY = value;
    });

    drawingColorEl.addEventListener('input', function () {
        if (canvas.freeDrawingBrush) canvas.freeDrawingBrush.color = this.value;
    });
    drawingShadowColorEl.addEventListener('input', function () {
        if (canvas.freeDrawingBrush) canvas.freeDrawingBrush.shadow.color = this.value;
    });

    setBrush(canvas.freeDrawingBrush);
    applyDrawing();
    refresh();
})();
