let pos = 0
let text = undefined
let text2 = undefined

function onBodyLoad () {
  text = document.getElementById("text")
  text2 = document.getElementById("text2")
  text.focus()
  text.selectionEnd = pos
  text.addEventListener("input", inputEventListener)
}

function initFocus (ta){
  text = ta
  pos = ta.selectionEnd
}

const inputEventListener = (e) => {
  pos = text.selectionEnd
  if (e.inputType === 'insertText'){
  }
  if (e.inputType === 'appendText'){
    if (pos == text.value.length){
      text.value = text.value + e.data
      pos = text.value.length
      text.focus();
      text.selectionEnd = pos
    } else {
      const prefix = text.value.substring(0, pos);
      const suffix = text.value.substring(pos);
      text.value = prefix + e.data + suffix
      pos = pos + 1
      
      text.selectionStart = pos
      text.selectionEnd = pos
      text.focus();
    }
  }
  if (e.inputType === 'deleteContentBackward'){
    pos = pos - 1
  }
  if (e.inputType === 'insertLineBreak'){
    pos = pos + 1
  }
  if (e.inputType === 'block'){
    const sel = text.value.substring(text.selectionStart,text.selectionEnd)
    text2.value = sel
    text2.focus();
    text2.selectionStart = 0 
  }
  if (e.inputType === 'home'){
    let endPos = pos
    while (pos > 0){
      pos = pos - 1
      if (text.value.charAt(pos) === '\n'){
        //text.focus();
        text.selectionEnd = endPos
        if (pos === 0){
          text.selectionStart = pos
        } else {
          text.selectionStart = pos+1
        }
	text.focus()
        break
      }
    }  
  }
  if (e.inputType === 'end'){
    let startPos = pos
    while (pos < text.value.length){
      pos = pos + 1
      if (text.value.charAt(pos) === '\n'){
        //text.focus();
        text.selectionStart = startPos
        text.selectionEnd = pos
	text.focus()
        break
      }
    }
  }
  if (e.inputType === 'up'){
    while (pos > 0){
      pos = pos - 1
      if (text.value.charAt(pos) === '\n'){
        break
      }
    }
    
    text.selectionStart = pos
    text.selectionEnd = pos
    text.focus();
  }
  if (e.inputType === 'down'){
    while (pos < text.value.length){
      pos = pos + 1
      if (text.value.charAt(pos) === '\n'){
        break
      }
    }
    text.selectionStart = pos
    text.selectionEnd = pos    
    text.focus();
  }
  if (e.inputType === 'left'){
    if (pos <= 0){
      text.focus();
      text.selectionStart = pos
      text.selectionEnd = pos
      return
    }
    text.focus();
    pos = pos - 1
    text.selectionEnd = pos
  }
  if (e.inputType === 'right'){
    if (pos >= text.value.length){
      text.focus();
      text.selectionStart = pos
      text.selectionEnd = pos
      return
    }
    text.focus();
    pos = pos + 1
    text.selectionStart = pos
    text.selectionEnd = pos
  }
}

