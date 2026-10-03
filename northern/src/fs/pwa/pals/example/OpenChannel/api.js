function doGetSync(url, cb) {
    doGet(url).then(ret => {cb(ret)}) ;
}
async function doGet(url) {
    const response = await fetch(url);
    const json = await response.json();
    return json;
}
function doPost(url, payload) {
    doPostOrPost (url, payload, 'POST');
    return {"status" : "OK"};
}
function doPut(url, payload) {
    doPostOrPost (url, payload, 'PUT');
    return {"status" : "OK"};
}
async function doPostOrPost(url, payload, method) {
  await fetch(url, {
    method: method,
    body: JSON.stringify(payload),
    headers: {
      'content-type': 'application/json'
    }
  });
}

function saveToStorage(id, record){
    if (!record || !id){
        return false;
    }
    window.localStorage.setItem(id, JSON.stringify(record));
    return true;
}
function loadFromStorage(id){
    if (!id){
        return false;
    }
    return JSON.parse (window.localStorage.getItem(id));
}
function loadStrFromStorage(id){
    if (!id){
        return false;
    }
    return window.localStorage.getItem(id);
}
function getTagValue(id){
    return document.getElementById(id).value;
}
function setTagValue(id, val){
    document.getElementById(id).value = val;
    return true;
}
function setTagHTML(id, val){
    document.getElementById(id).innerHTML = val;
    return true;
}
function getParameterByName(name, url) {
    if (!url) url = window.location.href;
    name = name.replace(/[\[\]]/g, '\\$&');
    var regex = new RegExp('[?&]' + name + '(=([^&#]*)|&|#|$)'),
        results = regex.exec(url);
    if (!results) return null;
    if (!results[2]) return '';
    return decodeURIComponent(results[2].replace(/\+/g, ' '));
}