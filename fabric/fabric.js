(function() {
  var fabricUrl = './lib/fabric.js';
  if (document.location.search.indexOf('load_fabric_from=') > -1) {
    var match = document.location.search.match(/load_fabric_from=([^&]*)/);
    if (match && match[1]) {
      fabricUrl = match[1];
    }
  }
  document.write('<script src="' + fabricUrl + '"><\/script>');
})();

var $ = function(id){return document.getElementById(id)};

function getDateFormatedStr(){
    return "DRAW_" + new Date().toISOString().slice(0, 19).replace(/-/g, "") + ".png";
}

function saveCanvas(){
    document.getElementById("down-png").download = getDateFormatedStr();
    document.getElementById("down-png").href = document.getElementById("c").toDataURL("image/png").replace(/^data:image\/[^;]/, 'data:application/octet-stream');
}
function saveCanvasJsonDeleted(){
}
function saveCanvasJson(){
    document.getElementById("down-json").download = getDateFormatedStr().replace('.png','.json');
    document.getElementById("down-json").href = 'data:application/octet-stream;base64,'+window.btoa(JSON.stringify(__canvas));
}

document.addEventListener('DOMContentLoaded', function() {

	var screenY = window.innerHeight;
	var screenX = window.innerWidth;
var tmpcanvas = document.getElementById("c");
tmpcanvas.height = screenY-60;
tmpcanvas.width = screenX-15;

  var canvas = this.__canvas = new fabric.Canvas('c', {
    isDrawingMode: true
  });

var context = tmpcanvas.getContext("2d");
var posX = 10;
var posY = 10;

function addText(){
	posX = (posX + 100)%screenX;
	posY = (posY + 20)%screenY;
	var tmpText = new fabric.Text($('textblob').value, {
  		fontFamily: 'Roboto',
		fontSize: 20,
		left: posX, top: posY
	});
	
var circle = new fabric.Circle({
  radius: 150,
  fill: '#eef',
  scaleY: 0.2,
  originX: 'center',
  originY: 'center'
});

var text = new fabric.Text($('textblob').value, {
  fontSize: 16,
  originX: 'center',
  originY: 'center',
  fontFamily: 'Comic Sans'
});

var group = new fabric.Group([ circle, text ], {
  left: 150,
  top: 100
});

	canvas.add(group);
	$('textblob').value='';
}

function addImg(src){ 
var myImg = new Image();
myImg.src = src;
myImg.onload = function() {
   //context.drawImage(myImg, 0, 0);
   var fabricImg = new fabric.Image(myImg);
	fabricImg.scaleToHeight(screenY);
	canvas.add(fabricImg);
};
}

/*
Ref:
https://www.positronx.io/understand-html5-filereader-api-to-upload-image-and-text-files/
http://head2toes.asuscomm.com/fs/get/Signin.html
https://www.tutorialspoint.com/Load-image-from-url-and-draw-to-HTML5-Canvas
*/

  document.getElementById('fileinput').addEventListener('change', function(){
            var file = this.files[0];
	    var reader = new FileReader(); // Creating reader instance from FileReader() API

	reader.addEventListener("load", function () { // Setting up base64 URL on image
    		//myImg.src = reader.result;
		addImg(reader.result);
	}, false);

	reader.readAsDataURL(file);
	});

  document.getElementById('jsoninput').addEventListener('change', function(){
            var file = this.files[0];
	    var reader = new FileReader(); // Creating reader instance from FileReader() API

	reader.addEventListener("load", function () { // Setting up base64 URL on image
    		//myImg.src = reader.result;
		canvas.loadFromJSON(window.atob(reader.result.split(',')[1]));
	}, false);

	reader.readAsDataURL(file);
	});

  fabric.Object.prototype.transparentCorners = false;

function Copy() {
	// clone what are you copying since you
	// may want copy and paste on different moment.
	// and you do not want the changes happened
	// later to reflect on the copy.
	canvas.getActiveObject().clone(function(cloned) {
		_clipboard = cloned;
	});
}
  
function Remove() {
  canvas.remove(canvas.getActiveObject());
}

function Paste() {
	// clone again, so you can do multiple copies.
	_clipboard.clone(function(clonedObj) {
		canvas.discardActiveObject();
		clonedObj.set({
			left: clonedObj.left + 10,
			top: clonedObj.top + 10,
			evented: true,
		});
		if (clonedObj.type === 'activeSelection') {
			// active selection needs a reference to the canvas.
			clonedObj.canvas = canvas;
			clonedObj.forEachObject(function(obj) {
				canvas.add(obj);
			});
			// this should solve the unselectability
			clonedObj.setCoords();
		} else {
			canvas.add(clonedObj);
		}
		_clipboard.top += 10;
		_clipboard.left += 10;
		canvas.setActiveObject(clonedObj);
		canvas.requestRenderAll();
	});
}
  
  var drawingModeEl = $('drawing-mode'),
      drawingOptionsEl = $('drawing-mode-options'),
      drawingColorEl = $('drawing-color'),
      drawingShadowColorEl = $('drawing-shadow-color'),
      drawingLineWidthEl = $('drawing-line-width'),
      drawingShadowWidth = $('drawing-shadow-width'),
      drawingShadowOffset = $('drawing-shadow-offset'),
      clearEl = $('clear-canvas'),
  copyEl = $('copy-el'),
  removeEl = $('remove-el'),
  pasteEl = $('paste-el');

 $('add-text').onclick = function() {addText()};

  copyEl.onclick = function() { Copy() };
  removeEl.onclick = function() { Remove() };  
  pasteEl.onclick = function() { Paste() };
  
  clearEl.onclick = function() { canvas.clear() };

  drawingModeEl.onclick = function() {
    canvas.isDrawingMode = !canvas.isDrawingMode;
    if (canvas.isDrawingMode) {
      drawingModeEl.innerHTML = 'Cancel drawing mode';
      drawingOptionsEl.style.display = '';
    }
    else {
      drawingModeEl.innerHTML = 'Enter drawing mode';
      drawingOptionsEl.style.display = 'none';
    }
  };

  if (fabric.PatternBrush) {
    var vLinePatternBrush = new fabric.PatternBrush(canvas);
    vLinePatternBrush.getPatternSrc = function() {

      var patternCanvas = fabric.document.createElement('canvas');
      patternCanvas.width = patternCanvas.height = 10;
      var ctx = patternCanvas.getContext('2d');

      ctx.strokeStyle = this.color;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(0, 5);
      ctx.lineTo(10, 5);
      ctx.closePath();
      ctx.stroke();

      return patternCanvas;
    };

    var hLinePatternBrush = new fabric.PatternBrush(canvas);
    hLinePatternBrush.getPatternSrc = function() {

      var patternCanvas = fabric.document.createElement('canvas');
      patternCanvas.width = patternCanvas.height = 10;
      var ctx = patternCanvas.getContext('2d');

      ctx.strokeStyle = this.color;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(5, 0);
      ctx.lineTo(5, 10);
      ctx.closePath();
      ctx.stroke();

      return patternCanvas;
    };

    var squarePatternBrush = new fabric.PatternBrush(canvas);
    squarePatternBrush.getPatternSrc = function() {

      var squareWidth = 10, squareDistance = 2;

      var patternCanvas = fabric.document.createElement('canvas');
      patternCanvas.width = patternCanvas.height = squareWidth + squareDistance;
      var ctx = patternCanvas.getContext('2d');

      ctx.fillStyle = this.color;
      ctx.fillRect(0, 0, squareWidth, squareWidth);

      return patternCanvas;
    };

    var diamondPatternBrush = new fabric.PatternBrush(canvas);
    diamondPatternBrush.getPatternSrc = function() {

      var squareWidth = 10, squareDistance = 5;
      var patternCanvas = fabric.document.createElement('canvas');
      var rect = new fabric.Rect({
        width: squareWidth,
        height: squareWidth,
        angle: 45,
        fill: this.color
      });

      var canvasWidth = rect.getBoundingRect().width;

      patternCanvas.width = patternCanvas.height = canvasWidth + squareDistance;
      rect.set({ left: canvasWidth / 2, top: canvasWidth / 2 });

      var ctx = patternCanvas.getContext('2d');
      rect.render(ctx);

      return patternCanvas;
    };

    var img = new Image();
    img.src = './icon-192.png';

    var texturePatternBrush = new fabric.PatternBrush(canvas);
    texturePatternBrush.source = img;
  }

  $('drawing-mode-selector').onchange = function() {

    if (this.value === 'hline') {
      canvas.freeDrawingBrush = vLinePatternBrush;
    }
    else if (this.value === 'vline') {
      canvas.freeDrawingBrush = hLinePatternBrush;
    }
    else if (this.value === 'square') {
      canvas.freeDrawingBrush = squarePatternBrush;
    }
    else if (this.value === 'diamond') {
      canvas.freeDrawingBrush = diamondPatternBrush;
    }
    else if (this.value === 'texture') {
      canvas.freeDrawingBrush = texturePatternBrush;
    }
    else {
      canvas.freeDrawingBrush = new fabric[this.value + 'Brush'](canvas);
    }

    if (canvas.freeDrawingBrush) {
      canvas.freeDrawingBrush.color = drawingColorEl.value;
      canvas.freeDrawingBrush.width = parseInt(drawingLineWidthEl.value, 10) || 1;
      canvas.freeDrawingBrush.shadow = new fabric.Shadow({
        blur: parseInt(drawingShadowWidth.value, 10) || 0,
        offsetX: 0,
        offsetY: 0,
        affectStroke: true,
        color: drawingShadowColorEl.value,
      });
    }
  };

  drawingColorEl.onchange = function() {
    canvas.freeDrawingBrush.color = this.value;
  };
  drawingShadowColorEl.onchange = function() {
    canvas.freeDrawingBrush.shadow.color = this.value;
  };
  drawingLineWidthEl.onchange = function() {
    canvas.freeDrawingBrush.width = parseInt(this.value, 10) || 1;
    this.previousSibling.innerHTML = this.value;
  };
  drawingShadowWidth.onchange = function() {
    canvas.freeDrawingBrush.shadow.blur = parseInt(this.value, 10) || 0;
    this.previousSibling.innerHTML = this.value;
  };
  drawingShadowOffset.onchange = function() {
    canvas.freeDrawingBrush.shadow.offsetX = parseInt(this.value, 10) || 0;
    canvas.freeDrawingBrush.shadow.offsetY = parseInt(this.value, 10) || 0;
    this.previousSibling.innerHTML = this.value;
  };

  if (canvas.freeDrawingBrush) {
    canvas.freeDrawingBrush.color = drawingColorEl.value;
    canvas.freeDrawingBrush.width = parseInt(drawingLineWidthEl.value, 10) || 1;
    canvas.freeDrawingBrush.shadow = new fabric.Shadow({
      blur: parseInt(drawingShadowWidth.value, 10) || 0,
      offsetX: 0,
      offsetY: 0,
      affectStroke: true,
      color: drawingShadowColorEl.value,
    });
  }

  fabric.util.addListener(fabric.window, 'load', function() {
    var canvas = this.__canvas || this.canvas,
        canvases = this.__canvases || this.canvases;

    canvas && canvas.calcOffset && canvas.calcOffset();

    if (canvases && canvases.length) {
      for (var i = 0, len = canvases.length; i < len; i++) {
        canvases[i].calcOffset();
      }
    }
  });
});
