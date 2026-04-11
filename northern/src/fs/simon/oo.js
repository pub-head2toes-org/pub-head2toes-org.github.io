const oo = {}

oo.genSalt = () => {
	var array = new Uint32Array(512);
	window.crypto.getRandomValues(array); 
    return crypto.subtle.digest("SHA-256", array).then(function (hash) {
    return oo.ab2b64(hash);
  });
}

oo.sha256 = (str) => {
    var buffer = new TextEncoder("utf-8").encode(str);
    return crypto.subtle.digest("SHA-256", buffer).then(function (hash) {
    	return oo.ab2b64(hash);
    });
}

oo.ab2b64 = (buf) => {
    return btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));
}

oo.str2ab = (base64) => {
    var binary_string = window.atob(base64);
    var len = binary_string.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) {
    	bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes.buffer;
}

oo.getDerivation = async(hash, salt, password, iterations, keyLength) => {
  const textEncoder = new TextEncoder("utf-8");
  const passwordBuffer = textEncoder.encode(password);
  const importedKey = await crypto.subtle.importKey("raw", passwordBuffer, "PBKDF2", false, ["deriveBits"]);
  
  const saltBuffer = textEncoder.encode(salt);
  const params = {name: "PBKDF2", hash: hash, salt: saltBuffer, iterations: iterations};
  const derivation = await crypto.subtle.deriveBits(params, importedKey, keyLength*8);
  return derivation;
}

oo.getKey = async(derivation) => {
  const ivlen = 16;
  const keylen = 32;
  const derivedKey = derivation.slice(0, keylen);
  const iv = derivation.slice(keylen);
  const importedEncryptionKey = await crypto.subtle.importKey('raw', derivedKey, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);
  return {
    key: importedEncryptionKey,
    iv: iv
  }
}

oo.encrypt = async(text, keyObject) => {
    const textEncoder = new TextEncoder("utf-8");
    const textBuffer = textEncoder.encode(text);
    const encryptedText = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: keyObject.iv }, keyObject.key, textBuffer);
    return encryptedText;
}

oo.decrypt = async (encryptedText, keyObject) => {
    const textDecoder = new TextDecoder("utf-8");
    const decryptedText = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: keyObject.iv }, keyObject.key, encryptedText);
    return textDecoder.decode(decryptedText);
}

oo.idme = async(password) => {
    const hash = "SHA-256";
    let salt = password.split('').reverse().join('');
    const iteratrions = 1000;
    const keyLength = 48;
    const derivation = await oo.getDerivation(hash, salt, password, iteratrions, keyLength);
    password = '';
    salt = '';
    return await oo.getKey(derivation);
}
