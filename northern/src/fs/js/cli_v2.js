var myCodeMirror,myCodeMirror2

window.addEventListener("DOMContentLoaded", function () {
  myCodeMirror = document.getElementById("text")
  myCodeMirror2 = document.getElementById("text2")
})

function getLine(textarea){
  let line = textarea.value.substr(0, textarea.selectionStart).split("\n").length-1
  return line
}

function getCmdLine(){
  let clip = document.getElementById("clip")
  return getLine(clip)
}

function getLineText(){
  let clip = document.getElementById("text")
  let line = getLine(clip)
  let lines = clip.value.split("\n")
  return lines[line]
}

function getLineText2(){
  let clip = document.getElementById("text2")
  return getLine(clip)
}

function timestampCursor(){
  let line = getCmdLine()
  let lines = clip.value.split("\n")
  let lineTxt = lines[line] + '/' + new Date().getTime()
  lines[line] = lineTxt
  clip.value = lines.join('\n')
  clip.focus()
}

function openWin (){
  let lineTxt = getCmdLine()
  let footer = document.getElementById("footer");
  if (lineTxt.match(/".*"/)){
    let tmpTokens = lineTxt.replace(/^[^"]*"/, '').split('"');
    if (tmpTokens && tmpTokens[0]){
  		window.open(tmpTokens[0],"blank")
    } else {
      footer.innerHTML = `no match: ${tmpTokens}`;
    }
  } else {
  	footer.innerHTML = `no match: ${lineTxt}`;
  }
}

function block (){
  let clip = document.getElementById("clip")
  let lineTxt = getLineText();
  let footer = document.getElementById("footer");
  const tokens = [];
  tokens.push("get");
  if (lineTxt.match(/"path".*:.*"/)){
    let tmpTokens = lineTxt.replace(/^.*"path".*: +/, '').split('"');
    if (tmpTokens && tmpTokens[1]){
      	clip.value = clip.value + "\n" + " " + tmpTokens[1]
        clip.scrollTop = clip.scrollHeight
        clip.focus()
  		tokens.push(tmpTokens[1]);
  		parseTokens(tokens);
    } else {
      footer.innerHTML = `no match: ${tmpTokens}`;
    }
  } else {
  	footer.innerHTML = `no match: ${lineTxt}`;
  }
}


function follow (){
  let clip = document.getElementById("clip")
  let lineTxt = getLineText();
  let footer = document.getElementById("footer");
  const tokens = [];
  tokens.push("get");
  if (lineTxt.match(/"path".*:.*"/)){
    let tmpTokens = lineTxt.replace(/^.*"path".*: +/, '').split('"');
    if (tmpTokens && tmpTokens[1]){
      	clip.value = clip.value + "\n" + "put2 " + tmpTokens[1]
  		tokens.push(tmpTokens[1]);
  		parseTokens(tokens);
    } else {
      footer.innerHTML = `no match: ${tmpTokens}`;
    }
  } else {
  	footer.innerHTML = `no match: ${lineTxt}`;
  }
}

function runCursor(){
  let line = getCmdLine()
  let lineTxt = clip.value.split("\n")[line];
  let tokens = lineTxt.split(' ');
  parseTokens(tokens);
}
  
function parseTokens(tokens){
  let footer = document.getElementById("footer");
  footer.innerHTML = `cmd: ${tokens[0]}`;
  if ('get' == tokens[0]){
    fetch(tokens[1]).then(function(response) {
        response.text().then(function (text) {
            myCodeMirror2.value = text
        });
    }).catch(function(error) {
        console.log('Looks like there was a problem: \n', error);
    });
  }
  if ('llmo' == tokens[0]){
    fetch(tokens[1]).then(function(response) {
        response.text().then(function (text) {
            myCodeMirror2.value = JSON.parse(text).response
        });
    }).catch(function(error) {
        console.log('Looks like there was a problem: \n', error);
    });
  }
 
  if ('search' == tokens[0]){
    fetch(`${tokens[1]}?search=%`).then(function(response) {
        response.text().then(function (text) {
          	let jsonSearchRes = JSON.parse(text);
          	jsonSearchRes.sort((a,b)=>{a>b});
            myCodeMirror.value = JSON.stringify(jsonSearchRes, null, 2)
        });
    }).catch(function(error) {
        console.log('Looks like there was a problem: \n', error);
    });
  }
    if ('last' == tokens[0]){
    fetch(`${tokens[1]}?search=%`).then(function(response) {
        response.text().then(function (text) {
            let json = JSON.parse(text)
            let lastDate = new Date(Number(json[json.length-1].path.slice(-13))) 
            json[json.length-1].date = lastDate.toLocaleDateString("en-US")
            myCodeMirror.value = JSON.stringify(json[json.length-1], null, 2)
        });
    }).catch(function(error) {
        console.log('Looks like there was a problem: \n', error);
    });
  }
 if ('open' == tokens[0]){
    let url = tokens[1]
    if (url){
  		window.open(url,"blank")
    }    
 }
 if ('llm' == tokens[0]){
    let url = tokens[1]
    let sseURL = "/sub/simon/lamela.json"
   	let hdrs = new Headers({});
    let data = `{"s": "prompt:${url}"}`
    let fetchData = { 
      method: 'PUT', 
      mode: 'cors',
      body: data,
      headers: hdrs
    }
    fetch(sseURL, fetchData).then(function(response) {
      response.text().then(function (text) {
        footer.innerHTML = 'llm: ' + encodeURI(text)
      });
    }).catch(function(error) {
      console.log('Looks like there was a problem: \n', error);
    }); 
  }
 
  if ('put' == tokens[0]){
    let url = tokens[1]
   	let hdrs = new Headers({});
    let data = myCodeMirror.value
    let fetchData = { 
      method: 'PUT', 
      mode: 'cors',
      body: data,
      headers: hdrs
    }
    fetch(url, fetchData).then(function(response) {
      response.text().then(function (text) {
        footer.innerHTML = 'res: ' + encodeURI(text)
      });
    }).catch(function(error) {
      console.log('Looks like there was a problem: \n', error);
    }); 
  }
  if ('put2' == tokens[0]){
    let url = tokens[1]
   	let hdrs = new Headers({});
    let data = myCodeMirror2.value
    let fetchData = { 
      method: 'PUT', 
      mode: 'cors',
      body: data,
      headers: hdrs
    }
    fetch(url, fetchData).then(function(response) {
      response.text().then(function (text) {
        footer.innerHTML = 'res: ' + encodeURI(text)
      });
    }).catch(function(error) {
      console.log('Looks like there was a problem: \n', error);
    }); 
  }
  if ('post' == tokens[0]){
    let url = tokens[1]
   	let hdrs = new Headers({});
    let data = myCodeMirror.value
    let fetchData = { 
      method: 'POST', 
      mode: 'cors',
      body: data,
      headers: hdrs
    }
    fetch(url, fetchData).then(function(response) {
      response.text().then(function (text) {
        footer.innerHTML = 'Ok'
        myCodeMirror2.value = text
      });
    }).catch(function(error) {
      console.log('Looks like there was a problem: \n', error);
    }); 
  }
  if ('match' == tokens[0]){
    if (tokens.length < 3){
      footer.innerHTML = 'match: Missing param. Ex. match path keyword';
      return;
    }
    fetch(`${tokens[1]}?search=%&kwd=${tokens[2]}`).then(function(response) {
        response.text().then(function (text) {
            myCodeMirror.value = JSON.stringify(JSON.parse(text), null, 2)
        });
    }).catch(function(error) {
        console.log('Looks like there was a problem: \n', error);
    });
  }
  if ('eval' == tokens[0]){
    let data = myCodeMirror.value
    try{
    	eval(data)
    } catch (err){
    	footer.innerHTML =`eval err: ${err}`
    }
  }
  if ('s' == tokens[0]){
    //myBrowserArea.src=tokens[1]
    let query = tokens.join ('+')
    query = query.replace ('s+','')
    window.open(`https://duckduckgo.com/?q=${query}`,"blank")
  }
}
