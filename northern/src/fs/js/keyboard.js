const Keyboard = {
    elements: {
        main: null,
        keysContainer: null,
        keys: []
    },

    eventHandlers: {
        oninput: null,
        onclose: null
    },

    properties: {
        value: "",
        capsLock: false,
      	inputType: "appendText"
    },

    init() {
        // Create main elements
        this.elements.main = document.createElement("div");
        this.elements.keysContainer = document.createElement("div");

        // Setup main elements
        // this.elements.main.classList.add("keyboard", "keyboard--hidden");
        this.elements.keysContainer.classList.add("keyboard__keys");
        this.elements.keysContainer.appendChild(this._createKeys());

        this.elements.keys = this.elements.keysContainer.querySelectorAll(".keyboard__key");

        // Add to DOM
        this.elements.main.appendChild(this.elements.keysContainer);
        document.getElementById("keyboard").appendChild(this.elements.main);
/*
        // Automatically use keyboard for elements with .use-keyboard-input
        document.querySelectorAll(".use-keyboard-input").forEach(element => {
            element.addEventListener("focus", () => {
                this.open(element.value, currentValue => {
                    element.value = currentValue;
                });
            });
        });
	*/
    },

    _createKeys() {
        const fragment = document.createDocumentFragment();
        const keyLayout = [
          
        "tab","home","end","left","up","down","right",
        
	    "\\","/","^","()","~`","=","_", "|", "{}","[]","'",'"',"<>",
	    "run","ts","follow","open","block",
          
        ];

        // Creates HTML for an icon
        const createIconHTML = (icon_name) => {
            return `<i class="material-icons">${icon_name}</i>`;
        };

        keyLayout.forEach(key => {
            const keyElement = document.createElement("button");
            const insertLineBreak = ["<>","right"].indexOf(key) !== -1;

            // Add attributes/classes
            keyElement.setAttribute("type", "button");
            keyElement.classList.add("keyboard__key");

            switch (key) {
                case "caps":
                    keyElement.classList.add("keyboard__key--wide", "keyboard__key--activatable");
                    keyElement.innerHTML = createIconHTML("keyboard_capslock");

                    keyElement.addEventListener("click", () => {
                        this._toggleCapsLock();
                        keyElement.classList.toggle("keyboard__key--active", this.properties.capsLock);
                    });

                    break;
		    
		case "up":
                    keyElement.classList.add("keyboard__key--wide", "keyboard__key--dark");
                    keyElement.innerHTML = createIconHTML("arrow_upward");

                    keyElement.addEventListener("click", () => {
			this.properties.inputType = "up";
                        this._triggerEvent("oninput");
                    });

                    break;

		case "down":
                    keyElement.classList.add("keyboard__key--wide", "keyboard__key--dark");
                    keyElement.innerHTML = createIconHTML("arrow_downward");

                    keyElement.addEventListener("click", () => {
       			this.properties.inputType = "down";
                        this._triggerEvent("oninput");
                    });

                    break;

		case "left":
                    keyElement.classList.add("keyboard__key--wide", "keyboard__key--dark");
                    keyElement.innerHTML = createIconHTML("chevron_left");

                    keyElement.addEventListener("click", () => {
			this.properties.inputType = "left";
                        this._triggerEvent("oninput");
                    });

                    break;

		case "right":
                    keyElement.classList.add("keyboard__key--wide", "keyboard__key--dark");
                    keyElement.innerHTML = createIconHTML("chevron_right");

                    keyElement.addEventListener("click", () => {
       			this.properties.inputType = "right";
                        this._triggerEvent("oninput");
                    });

                    break;

        case "home":
                    keyElement.classList.add("keyboard__key--wide", "keyboard__key--dark");
                    keyElement.innerHTML = createIconHTML("switch_left");

                    keyElement.addEventListener("click", () => {
       			this.properties.inputType = "home";
                        this._triggerEvent("oninput");
                    });

                    break;

		case "end":
                    keyElement.classList.add("keyboard__key--wide", "keyboard__key--dark");
                    keyElement.innerHTML = createIconHTML("switch_right");

                    keyElement.addEventListener("click", () => {
       			this.properties.inputType = "end";
                        this._triggerEvent("oninput");
                    });

                    break;

		case "block":
                    keyElement.classList.add("keyboard__key--wide", "keyboard__key--dark");
                    keyElement.innerHTML = createIconHTML("code");

                    keyElement.addEventListener("click", () => {
       			            //this.properties.inputType = "block";
                        //this._triggerEvent("oninput");
                        block()
                    });

                    break;
                
                    case "run":
                    keyElement.classList.add("keyboard__key--wide", "keyboard__key--dark");
                    keyElement.textContent = "run";

                    keyElement.addEventListener("click", () => {
        				runCursor()
                    });

                    break;
                
                    case "ts":
                    keyElement.classList.add("keyboard__key--wide", "keyboard__key--dark");
                    keyElement.textContent = "ts";

                    keyElement.addEventListener("click", () => {
        				timestampCursor()
                    });

                    break;
                
                    case "follow":
                    keyElement.classList.add("keyboard__key--wide", "keyboard__key--dark");
                    keyElement.textContent = "f";

                    keyElement.addEventListener("click", () => {
        				follow()
                    });

                    break;
                
                    case "open":
                    keyElement.classList.add("keyboard__key--wide", "keyboard__key--dark");
                    keyElement.textContent = "open";

                    keyElement.addEventListener("click", () => {
        				openWin()
                    });

                    break;
                case "tab":
                    keyElement.classList.add("keyboard__key--wide", "keyboard__key--dark");
                    keyElement.textContent = "tab";

                    keyElement.addEventListener("click", () => {
        				this.properties.value = "\t";
                      	this.properties.inputType = 'appendText'
                        this._triggerEvent("oninput");
                    });

                    break;

                default:
                    keyElement.textContent = key.toLowerCase();

                    keyElement.addEventListener("click", () => {
                      	let val = this.properties.capsLock ? key.toUpperCase() : key.toLowerCase()
                        this.properties.value = val
                      	this.properties.inputType = 'appendText'
                        this._triggerEvent("oninput")
                    });

                    break;
            }

            fragment.appendChild(keyElement);

            if (insertLineBreak) {
                fragment.appendChild(document.createElement("br"));
            }
        });

        return fragment;
    },

    _triggerEvent(handlerName) {
	    /*
        if (typeof this.eventHandlers[handlerName] == "function") {
            this.eventHandlers[handlerName](this.properties.value);
        }
	*/
	    console.log(this.properties.value);
	    //ws.send(this.properties.value);
      	let ta = document.getElementById("text")
        let event = new Event('input', {
            bubbles: true
        });
      	event.data = this.properties.value
      	event.inputType = this.properties.inputType
        ta.dispatchEvent(event)
    },

    _toggleCapsLock() {
        this.properties.capsLock = !this.properties.capsLock;

        for (const key of this.elements.keys) {
            if (key.childElementCount === 0) {
                key.textContent = this.properties.capsLock ? key.textContent.toUpperCase() : key.textContent.toLowerCase();
            }
        }
    },

    open(initialValue, oninput, onclose) {
        this.properties.value = initialValue || "";
        this.eventHandlers.oninput = oninput;
        this.eventHandlers.onclose = onclose;
        this.elements.main.classList.remove("keyboard--hidden");
    },

    close() {
        this.properties.value = "";
        this.eventHandlers.oninput = oninput;
        this.eventHandlers.onclose = onclose;
        this.elements.main.classList.add("keyboard--hidden");
    }
};

window.addEventListener("DOMContentLoaded", function () {
    Keyboard.init();
});

