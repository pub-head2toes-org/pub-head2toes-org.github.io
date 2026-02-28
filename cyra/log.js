var keyObject = {};
var latestEntries = [];
const MAX_ENTRIES = 6;
const props = {};
props.isIdKeySet = false;
props.offset = 0;
props.searchRes = [];
const keySpace = 'apps-cyra-'

document.getElementById("idme").onclick = idme;
document.getElementById("rekey").onclick = rekey;
document.getElementById("new").onclick = getNewEntryKey;
document.getElementById("save").onclick = saveEntry;
document.getElementById("export").onclick = saveToNamedFile;
document.getElementById("search").onclick = doSearch;
document.getElementById("clear").onclick = clearSearch;
document.getElementById("next").onclick = next;
document.getElementById("prev").onclick = prev;

document.getElementById("tog_id").onclick = togId;
document.getElementById("tog_new").onclick = togNew;

setMyList();

document.getElementById('fileinput').addEventListener('change', function() {
  var file = this.files[0];
  console.log("name : " + file.name);
  console.log("size : " + file.size);
  console.log("type : " + file.type);
  console.log("date : " + file.lastModified);

  var reader = new FileReader();

  reader.onload = function(e) {
    var text = reader.result;
    let content = JSON.parse(text);
    for (let i = 0; i < content.length; i++) {
      localStorage.setItem(reKey(content[i].key), content[i].val);
    }
    latestEntries = [];
    setMyList();
  }

  reader.readAsText(file);
}, false);

function togId() {
  const togNew = document.getElementById("tog_new");
  const secId = document.getElementById("sec_id");
  const secWorkspace = document.getElementById("sec_workspace");
  if (secId.className === "sec-on") {
    secId.className = "sec-off";
    if (props.isIdKeySet) {
      togNew.className = "tog-button";
      secWorkspace.className = "sec-on";
    }
  } else {
    secId.className = "sec-on";
    secWorkspace.className = "sec-off";
    togNew.className = "sec-off";
  }
}

function togNew() {
  const togId = document.getElementById("tog_id");
  const togNew = document.getElementById("tog_new");
  const saveButton = document.getElementById("save");
  const secNew = document.getElementById("sec_new");
  const secWorkspace = document.getElementById("sec_workspace");
  document.getElementById("entryText").value = '';
  if (secNew.className === "sec-on") {
    secNew.className = "sec-off";
    secWorkspace.className = "sec-on";
    togId.className = "tog-button";
    togNew.innerHTML = "NEW ENTRY";
    document.getElementById("entryKey").innerHTML = "";
    saveButton.className = "sec-off";
  } else {
    secNew.className = "sec-on";
    togNew.innerHTML = "CANCEL ENTRY";
    secWorkspace.className = "sec-off";
    togId.className = "sec-off";
  }
}

function reKey(key) {
  if (key.startsWith(keySpace)){
  return key
  } else {
  return keySpace+(new Date(key)).getTime()
  }
}

async function clearSearch() {
  latestEntries = [];
  props.searchRes = [];
  props.offset = 0;
  setMyList();
  document.getElementById("searchText").value = "";
  document.getElementById("trailText").value = "";
}

async function next() {
  latestEntries = [...(props.searchRes)];
  props.offset = props.offset + 6;
  setMyList();
}

async function prev() {
  if (props.offset == 0)
    return;
  latestEntries = [...(props.searchRes)];
  props.offset = props.offset - 6;
  setMyList();
}

async function doSearch() {
  let searchText = document.getElementById("searchText").value;
  let res = [];
  latestEntries = [];
  props.offset = 0;
  let n = localStorage.length;
  for (let i = 0; i < n; i++) {
    if (!localStorage.key(i).startsWith(keySpace)) {
      continue
    }
    let key = localStorage.key(i);
    let val = localStorage.getItem(key);
    let decryptedObject = undefined;
    try {
      decryptedObject = await decrypt(str2ab(val), keyObject);
    } catch (err) {
      continue;
    }
    if (decryptedObject == undefined) {
      continue;
    }
    try {
      let entry = JSON.parse(decryptedObject).val;
      if (entry.includes(searchText)) {
        res.push(key);
      }
    } catch (err) {
      continue;
    }
  }
  document.getElementById("trailText").value = `
Found: ${res.length}
Note: Search is case sensitive
`;

  if (res.length > 0) {
    res.sort().reverse();
    props.searchRes = [...res];
    latestEntries = [...res];
    setMyList();
  }
}

function saveToNamedFile() {
  var d = new Date().toISOString().slice(0, 19).replace(/-/g, "");
  var content = [];
  let n = localStorage.length;
  for (let i = 0; i < n; i++) {
    if (!localStorage.key(i).startsWith(keySpace)) {
      continue
    }
    let entry = {};
    entry.key = localStorage.key(i);
    entry.val = localStorage.getItem(localStorage.key(i));
    content.push(entry);
  }
  content = JSON.stringify(content);
  var uriContent = "data:application/octet-stream," + encodeURIComponent(content);
  var downloadLink = document.createElement("a");
  downloadLink.href = uriContent;
  downloadLink.download = d + ".export.json";

  document.body.appendChild(downloadLink);
  downloadLink.click();
  document.body.removeChild(downloadLink);
}

function getNewEntryKey() {

  const saveButton = document.getElementById("save");
  let key = getNewKey();
  document.getElementById("entryKey").innerHTML = getDesc(key);
  document.getElementById("entryKeyVal").value = key;
  saveButton.className = "button";
}

async function rekey() {
  const hash = "SHA-256";
  const sectionWorkspace = document.getElementById("sec_workspace");
  const sectionId = document.getElementById("sec_id");
  const togNew = document.getElementById("tog_new");
  const sectionIdIndicator = document.getElementById("sec_id_indicator");
  let password = document.getElementById("pass").value;
  let salt = password.split('').reverse().join('');
  document.getElementById("pass").value = '';
  const iteratrions = 1000;
  const keyLength = 48;
  const derivation = await getDerivation(hash, salt, password, iteratrions, keyLength);
  password = '';
  salt = '';
  // create a new key
  const newKeyObject = await getKey(derivation);
  let n = localStorage.length;
  for (let i = 0; i < n; i++) {
    if (!localStorage.key(i).startsWith(keySpace)) {
      continue
    }
    let entry = {};
    // load the entry for the key from local storage
    entry.key = localStorage.key(i);
    entry.val = localStorage.getItem(localStorage.key(i));
    try {
    // decrypt entry with key
    const decryptedObject = await decrypt(str2ab(entry.val), keyObject);
    const decryptedEntry = JSON.parse(decryptedObject);
    // encrypt with a new key
    entry.val = decryptedEntry.val;
    const encryptedObject = await encrypt(JSON.stringify(entry), newKeyObject);
    // put it back to a local storage
    localStorage.setItem(entry.key, ab2b64(encryptedObject));
    } catch (err) {
      console.log(`rekey failed for: ${entry.key}`);
    }
  }
  // finish re-keying
  keyObject = newKeyObject;

  sectionWorkspace.className = 'sec-on';
  sectionId.className = 'sec-off';
  togNew.className = 'tog-button';
  sectionIdIndicator.innerHTML = 'ID Key is set';
  props.isIdKeySet = true;
}


async function idme() {
  const hash = "SHA-256";
  const sectionWorkspace = document.getElementById("sec_workspace");
  const sectionId = document.getElementById("sec_id");
  const togNew = document.getElementById("tog_new");
  const sectionIdIndicator = document.getElementById("sec_id_indicator");
  let password = document.getElementById("pass").value;
  let salt = password.split('').reverse().join('');
  document.getElementById("pass").value = '';
  const iteratrions = 1000;
  const keyLength = 48;
  const derivation = await getDerivation(hash, salt, password, iteratrions, keyLength);
  password = '';
  salt = '';
  keyObject = await getKey(derivation);
  sectionWorkspace.className = 'sec-on';
  sectionId.className = 'sec-off';
  togNew.className = 'tog-button';
  sectionIdIndicator.innerHTML = 'ID Key is set';
  props.isIdKeySet = true;
}

async function saveEntry() {
  let key = document.getElementById("entryKeyVal").value;
  let val = document.getElementById("entryText").value;
  if (key == "") {
    togNew();
    return Promise.resolve("");
  }
  if (val == "") {
    document.getElementById("entryKeyVal").value = "";
    document.getElementById("entryKey").innerHTML = ""
    togNew();
    return Promise.resolve("");
  }
  let entry = {};
  entry.val = val;
  entry.type = 'Main';
  const encryptedObject = await encrypt(JSON.stringify(entry), keyObject);
  localStorage.setItem(key, ab2b64(encryptedObject));
  if (!latestEntries.includes(key)) {
    latestEntries.unshift(key);
  }
  setMyList();
  document.getElementById("entryKeyVal").value = "";
  document.getElementById("entryKey").innerHTML = "";
  togNew();
}

async function load() {
  //await saveEntry();
  let key = this.id;
  const val = localStorage.getItem(key);
  const decryptedObject = await decrypt(str2ab(val), keyObject);
  const entry = JSON.parse(decryptedObject);
  document.getElementById("entryText").value = entry.val;
}

function str2abOLD(str) {
  var buf = new ArrayBuffer(str.length * 2);
  // 2 bytes for each char
  var bufView = new Uint16Array(buf);
  for (var i = 0; i < str.length; i++) {
    bufView[i] = str.charCodeAt(i);
  }
  return buf;
}

function str2ab(base64) {
  var binary_string = window.atob(base64);
  var len = binary_string.length;
  var bytes = new Uint8Array(len);
  for (var i = 0; i < len; i++) {
    bytes[i] = binary_string.charCodeAt(i);
  }
  return bytes.buffer;
}

function ab2b64(buf) {
  return btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));
}

function setMyList() {
  var desc = [];
  var ids = [];

  if (props.searchRes && props.searchRes.length > 0) {
    latestEntries = [];
    for (let i = 0; i < MAX_ENTRIES; i++) {
      latestEntries.push(props.searchRes[i + props.offset]);
    }
  }

  if (latestEntries.length === 0) {

    let localList = []
    let n = localStorage.length;
    for (let i = 0; i < n; i++) {
      if (!localStorage.key(i).startsWith(keySpace)) {
        continue
      }
      localList.push(localStorage.key(i));
    }
    localList.sort().reverse();
    for (let i = 0; i < MAX_ENTRIES && i < n; i++) {
      latestEntries.push(localList[i + props.offset]);
    }
  }
  for (let i = 0; i < latestEntries.length; i++) {
    ids.push(latestEntries[i]);
    desc.push(getDesc(latestEntries[i]));
  }

  var list = document.getElementById('list')
  list.innerHTML = '';
  var fragment = new DocumentFragment()

  for (let i = 0; i < desc.length && i < MAX_ENTRIES; i++) {
    var li = document.createElement('li')
    li.id = ids[i];
    li.onclick = load;
    li.innerHTML = ' ' + desc[i]
    fragment.appendChild(li)
  }
  list.appendChild(fragment)
}

function getNewKey() {
  return keySpace + new Date().getTime()
}

function getDesc(key) {
  if (key == undefined) {
    return ""
  }
  let current = Number(key.replace(keySpace, ""))
  try {
    return getLocalISOTime(current)
  } catch(err) {
    return key
  }
}

function getLocalISOTime() {
  return getLocalISOTime(Date.now())
}

function getLocalISOTime(current) {
  var tzoffset = (new Date()).getTimezoneOffset() * 60000;
  //offset in milliseconds
  var localISOTime = (new Date(current - tzoffset)).toISOString().slice(0, -1);
  // => '2015-01-26T06:40:36.181'
  return localISOTime.replace("T", "-T");
}


// Register service worker for PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(registration => {
        console.log('ServiceWorker registration successful');
      })
      .catch(err => {
        console.log('ServiceWorker registration failed: ', err);
      });
  });
}
