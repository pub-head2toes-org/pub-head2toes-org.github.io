// Yambino - Yahtzee board presentation PWA
// Main application logic

var c; // context
var canvas = document.getElementById("canvas");
var debug = true;
var kill = false; // safety feature to kill script

var width = 500;
var height = 500;
var positions = [];
var noOfDice = 6;
let attemptCnt = 0;

var centerX, centerY;
var elemLeft, elemTop;

let canvasSelect = document.getElementById("canvas-select");
var selLeft, selTop;

let ctx = canvasSelect.getContext('2d');
let selections = []; // new Array(noOfDice);

let total = 1;

// Initialize canvas sizes and positions
function initCanvas() {
    var container = document.getElementById('canvas-container');
    var containerWidth = container.clientWidth;
    
    // Main canvas - use container width, height based on viewport
    canvas.width = containerWidth;
    canvas.height = window.innerHeight * 0.5; // 50% of viewport height
    width = canvas.width;
    height = canvas.height;
    centerX = width / 2;
    centerY = height / 2;
    
    // Get canvas position for click calculations
    var rect = canvas.getBoundingClientRect();
    elemLeft = rect.left + window.scrollX;
    elemTop = rect.top + window.scrollY;
    
    // Selection canvas - same width, fixed height
    canvasSelect.width = containerWidth;
    canvasSelect.height = 120;
    
    // Get selection canvas position
    var selRect = canvasSelect.getBoundingClientRect();
    selLeft = selRect.left + window.scrollX;
    selTop = selRect.top + window.scrollY;
    
    // Reset selection canvas context
    ctx = canvasSelect.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.translate(50, 50);
    
    // Redraw both canvases
    redrawMainCanvas();
    redrawSelected(selections, -1, ctx); // -1 means no removal, just redraw
}

// Handle window resize
window.addEventListener('resize', function() {
    initCanvas();
});

// Initialize on load
initCanvas();

canvasSelect.addEventListener('click', function(event) {
    var x = event.pageX - selLeft,
        y = event.pageY - selTop;

    let clickIndex = selectionExists(x + 25, y + 25, selections);
    if (!(clickIndex === false)) {
        // Get the dice value before removing from selections
        var diceValue = selections[clickIndex][2];
        total = total - 1;
        noOfDice = noOfDice + 1;
        ctx = canvasSelect.getContext('2d');

        // Remove from selections and redraw selection canvas
        redrawSelected(selections, clickIndex, ctx);
        
        // Add dice back to main canvas
        addDiceToMainCanvas(diceValue);
    }
});

canvas.addEventListener('click', function(event) {
    var x = event.pageX - elemLeft,
        y = event.pageY - elemTop;

    let clickRes = exists(x - centerX, y - centerY, positions);
    if (clickRes) {
        if (total > 5) {
            return;
        }
        // Remove the clicked dice from positions array
        var clickIndex = -1;
        for (var j = 0; j < positions.length; j++) {
            if (positions[j] === clickRes) {
                clickIndex = j;
                break;
            }
        }
        if (clickIndex !== -1) {
            positions.splice(clickIndex, 1);
            noOfDice = positions.length;
        }
        // Redraw main canvas without the selected dice
        redrawMainCanvas();
        // Add to selection canvas
        drawDice(ctx, clickRes[2]);
        selections.push([50 + total * 75, 50, clickRes[2]]);
        total = total + 1;
        ctx.translate(75, 0);
    } else {
        // document.getElementById('number-click').value = '';
    }
});

function redrawSelected(selections, clickIndex, ctx) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvasSelect.width, canvasSelect.height);
    if (clickIndex !== -1) {
        selections.splice(clickIndex, 1);
    }
    ctx.translate(50, 50);
    for (let i = 0; i < selections.length; i++) {
        drawDice(ctx, selections[i][2]);
        ctx.translate(75, 0);
    }
}

function redrawMainCanvas() {
    c = canvas.getContext('2d');
    c.clearRect(0, 0, width, height);
    c.translate(centerX, centerY);
    for (var i = 0; i < positions.length; i++) {
        c.save();
        c.translate(positions[i][0], positions[i][1]);
        c.rotate(positions[i][3] || 0); // Use stored rotation
        drawDice(c, positions[i][2]);
        c.restore();
    }
    c.translate(-centerX, -centerY);
}

function addDiceToMainCanvas(diceValue) {
    // Find a non-overlapping position
    var pos1 = 0;
    var pos2 = 0;
    var counter = 0;
    
    while (exists(pos1, pos2, positions)) {
        pos1 = (Math.floor(Math.random() * 3) - 1) * (Math.floor(Math.random() * 145) + 60);
        pos2 = (Math.floor(Math.random() * 3) - 1) * (Math.floor(Math.random() * 145) + 60);
        counter++;
        if (counter >= 500000) {
            kill = true;
            break;
        }
    }
    if (kill) return;
    
    // Generate random rotation and store it
    var rotation = (Math.random() * 175) * Math.PI / 180;
    
    // Add to positions array with rotation at index 3
    positions.push([pos1, pos2, diceValue, rotation]);
    noOfDice = positions.length;
    
    // Redraw main canvas
    redrawMainCanvas();
}

function newDraw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.translate(50, 50);
    total = 1;
    noOfDice = 6;
    selections = [];
    attemptCnt = 0;
    document.getElementById('attemptCnt').innerHTML = attemptCnt;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, width, height);
    positions = [];
    
    // Re-enable draw button
    var drawBtn = document.querySelector('button[onclick="draw()"]');
    if (drawBtn) {
        drawBtn.disabled = false;
        drawBtn.style.backgroundColor = '';
        drawBtn.style.cursor = '';
    }
    
    draw();
}

function doResize() {
    // Adjust width when resizing window
    var el = document.getElementById('canvas-container');
    width = Math.min(el.offsetWidth, 500);
    canvas.width = width;

    // Roll the dice when the page resizes or loads
    draw();

    if (debug) console.log('onresize width', width);
}

function drawDice(c, selectNumber) {
    if (kill) return;
    drawSquare(c); // replaced old way so stroke is enabled

    // draws glare
    c.fillStyle = "rgba(200,200,200,0.4)";
    c.globalAlpha = 1.0;
    c.beginPath();
    c.moveTo(-25, 25);
    c.lineTo(25, 25);
    c.bezierCurveTo(0, 15, -10, 15, -25, -25);
    c.closePath();
    c.fill();

    // draw dots
    var n = Math.floor(Math.random() * 6) + 1; // 1-6 dots
    if (selectNumber) {
        n = selectNumber;
    }
    c.save();
    c.fillStyle = "black";
    if (n == 1) {
        drawDot(0, 0, c);
    } else if (n == 2) {
        drawDot(16, 16, c);
        drawDot(-16, -16, c);
    } else if (n == 3) {
        drawDot(0, 0, c);
        drawDot(16, 16, c);
        drawDot(-16, -16, c);
    } else if (n == 4) {
        drawDot(16, 16, c);
        drawDot(-16, -16, c);
        drawDot(-16, 16, c);
        drawDot(16, -16, c);
    } else if (n == 5) {
        drawDot(0, 0, c);
        drawDot(16, 16, c);
        drawDot(-16, -16, c);
        drawDot(-16, 16, c);
        drawDot(16, -16, c);
    } else { // 6
        drawDot(16, 16, c);
        drawDot(-16, -16, c);
        drawDot(-16, 16, c);
        drawDot(16, -16, c);
        drawDot(16, 0, c);
        drawDot(-16, 0, c);
    }
    c.restore();
    return n;
}

function drawDot(x, y, c) {
    c.beginPath();
    c.arc(x, y, 5, 0, Math.PI * 2, true);
    c.closePath();
    c.fill();
}

function drawSquare(c) {
    c.strokeStyle = "#000";
    c.fillStyle = "#FFF";
    c.beginPath();
    c.moveTo(-30, -30);
    c.lineTo(30, -30);
    c.lineTo(30, 30);
    c.lineTo(-30, 30);
    c.lineTo(-30, -30);
    c.closePath();
    c.stroke();
    c.fill();
}

function selectionExists(pos1, pos2, positions) {
    if (kill) return false;
    for (var j = 0; j < positions.length; j++) {
        var p = positions[j];
        if (pos1 >= 50 + j * 75 && pos1 <= 50 + (j + 1) * 75) {
            if (pos2 >= 50 && pos2 <= 50 + 75) {
                if (debug) console.log("Oh No (" + pos1 + ", " + pos2 + ") is already used!");
                return j;
            }
        }
    }
    return false;
}

function exists(pos1, pos2, positions) {
    if (kill) return false;
    for (var j = 0; j < positions.length; j++) {
        var p = positions[j];
        if (pos1 + 55 >= p[0] && pos1 - 55 <= p[0]) {
            if (pos2 + 55 >= p[1] && pos2 - 55 <= p[1]) {
                if (debug) console.log("Oh No (" + pos1 + ", " + pos2 + ") is already used!");
                return p;
            }
        }
    }
    return false;
}

function draw() {
    // Limit to 3 draws
    if (attemptCnt >= 3) {
        var drawBtn = document.querySelector('button[onclick="draw()"]');
        if (drawBtn) {
            drawBtn.disabled = true;
            drawBtn.style.backgroundColor = '#666';
            drawBtn.style.cursor = 'not-allowed';
        }
        return;
    }

    kill = false;
    var num = noOfDice;

    attemptCnt = attemptCnt + 1;
    document.getElementById('attemptCnt').innerHTML = attemptCnt;

    // Disable draw button after 3rd draw
    if (attemptCnt >= 3) {
        var drawBtn = document.querySelector('button[onclick="draw()"]');
        if (drawBtn) {
            drawBtn.disabled = true;
            drawBtn.style.backgroundColor = '#666';
            drawBtn.style.cursor = 'not-allowed';
        }
    }

    c = canvas.getContext('2d');
    c.clearRect(0, 0, width, height); // clears previous dice

    // all other translates are relative to this one, this is now 0,0
    // TODO: Fix for screens smaller than 500px
    c.translate(centerX, centerY);

    var pos1 = 0;
    var pos2 = 0;
    positions = new Array(num);

    // create 2dim array with num rows and 2 columns
    for (var i = 0; i < num; i++) {
        positions[i] = new Array(3);
    }

    // draw the num of dice
    for (var i = 0; i < num; i++) {

        if (debug) console.log("rolling: (" + pos1 + ", " + pos2 + ")"); // always starts at 0,0
        var counter = 0;

        while (exists(pos1, pos2, positions)) {
            pos1 = (Math.floor(Math.random() * 3) - 1) * (Math.floor(Math.random() * 145) + 60);
            pos2 = (Math.floor(Math.random() * 3) - 1) * (Math.floor(Math.random() * 145) + 60);
            if (debug) console.log("rolling: (" + pos1 + ", " + pos2 + ")");
            counter++;
            if (counter >= 500000) { // kills script if it takes too long
                alert("Are you trying to crash your browser!? Ceriously...");
                kill = true;
                break;
            }
        }
        if (kill) break;

        positions[i][0] = pos1;
        positions[i][1] = pos2;

        c.save();
        c.translate(pos1, pos2);
        var rotation = (Math.random() * 175) * Math.PI / 180;
        c.rotate(rotation);
        positions[i][2] = drawDice(c);
        positions[i][3] = rotation; // Store rotation
        c.restore();
        // get new coordinates
        pos1 = (Math.floor(Math.random() * 3) - 1) * (Math.floor(Math.random() * 145) + 60);
        pos2 = (Math.floor(Math.random() * 3) - 1) * (Math.floor(Math.random() * 145) + 60);
    }
    c.translate(-centerX, -centerY); // moves translation back
} // end draw()

// Attach resize event
// window.onresize = doResize;

// Perform resize
// doResize();

// Service Worker registration
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
        .then(function() {
            console.log('Service Worker Registered');
        });
}